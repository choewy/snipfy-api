import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { And, DataSource, In, LessThanOrEqual } from 'typeorm';
import { DateTime } from 'luxon';

import { Link } from 'src/domain/entities/link.entity';
import { LinkStatus, LinkType } from 'src/domain/enums';
import { UserSpecification } from 'src/domain/entities/user-specification.entity';
import { LinkStatistics } from 'src/domain/entities/link-statistics.entity';
import { LinkHitHistory } from 'src/domain/entities/link-hit-history.entity';
import { AppConfigFactory } from 'src/common/config/providers/app-config.factory';
import { ContextService } from 'src/common/context/context.service';
import { RedisService } from 'src/common/redis/redis.service';
import { TimerService } from 'src/common/timer/timer.service';

import { LinkDTO } from './dto/link.dto';
import { GetLinksRequestDTO } from './dto/get-links-request.dto';
import { GetLinksResponseDTO } from './dto/get-links-response.dto';
import { HitLinkResponseDTO } from './dto/hit-link-response.dto';
import { CreateLinkRequestDTO } from './dto/create-link-request.dto';
import { CreateLinkResponseDTO } from './dto/create-link-response.dto';
import { UpdateLinkRequestDTO } from './dto/update-link-request.dto';

@Injectable()
export class LinkService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly appConfigFactory: AppConfigFactory,
    private readonly contextService: ContextService,
    private readonly redisService: RedisService,
    private readonly timerService: TimerService,
  ) {}

  async getLinks(param: GetLinksRequestDTO) {
    const linkRepository = this.dataSource.getRepository(Link);
    const [links, count] = await linkRepository.findAndCount({
      relations: { statistics: true },
      where: {
        userId: this.contextService.getRequestUserID() ?? '0',
      },
      skip: param.skip,
      take: param.take,
    });

    return new GetLinksResponseDTO(links, count);
  }

  async getLink(id: string) {
    const linkRepository = this.dataSource.getRepository(Link);
    const link = await linkRepository.findOne({
      relations: { statistics: true },
      where: { id, userId: this.contextService.getRequestUserID() },
    });

    if (!link) {
      throw new BadRequestException();
    }

    return new LinkDTO(link);
  }

  async createLink(body: CreateLinkRequestDTO) {
    const userId = this.contextService.getRequestUserID();

    const days = userId === null ? 7 : 30;
    const expiredAt = body.type === LinkType.Free ? DateTime.local().plus({ days }).toJSDate() : null;

    const link = await this.dataSource.transaction(async (em) => {
      const linkRepository = em.getRepository(Link);
      const link = linkRepository.create({
        userId,
        url: body.url,
        type: body.type,
        expiredAt,
      });

      while (true) {
        link.id = link.createId();

        const hasId = await linkRepository.exists({
          select: { id: true },
          where: { id: link.id },
          lock: { mode: 'pessimistic_write' },
          take: 1,
        });

        if (!hasId) {
          break;
        }
      }

      await linkRepository.insert(link);

      const linkStatisticsRepository = em.getRepository(LinkStatistics);
      await linkStatisticsRepository.insert({ linkId: link.id });

      if (userId) {
        const userSpecificationRepository = em.getRepository(UserSpecification);
        await userSpecificationRepository
          .createQueryBuilder()
          .update({ linkCount: () => 'linkCount + 1' })
          .where({ userId })
          .execute();
      }

      return link;
    });

    return new CreateLinkResponseDTO(this.appConfigFactory.getLinkBaseURL(), link);
  }

  async hitLink(id: string) {
    const linkRepository = this.dataSource.getRepository(Link);
    const link = await linkRepository.findOne({
      select: { id: true, url: true, statusCode: true },
      where: { id },
    });

    if (!link || link.status === LinkStatus.Disabled) {
      throw new NotFoundException();
    }

    if (link.expiredAt instanceof Date) {
      const expiredAt = DateTime.fromJSDate(link.expiredAt);

      if (expiredAt && expiredAt.diffNow('milliseconds').get('milliseconds') < 0) {
        throw new NotFoundException();
      }
    }

    await this.dataSource.transaction(async (em) => {
      const linkHitHistoryRepository = em.getRepository(LinkHitHistory);
      await linkHitHistoryRepository.insert(linkHitHistoryRepository.create({ link }));

      const linkStatisticsRepository = em.getRepository(LinkStatistics);
      await linkStatisticsRepository
        .createQueryBuilder()
        .update({ hitCount: () => `hitCount + 1` })
        .where({ linkId: id })
        .execute();
    });

    return new HitLinkResponseDTO(link);
  }

  async updateLink(id: string, body: UpdateLinkRequestDTO) {
    const linkRepository = this.dataSource.getRepository(Link);
    const link = await linkRepository.findOneBy({ id });

    if (!link || link.userId !== this.contextService.getRequestUserID()) {
      return;
    }

    await linkRepository.update(
      { id },
      {
        status: body.status && body.status !== link.status ? body.status : undefined,
        statusCode: body.statusCode && body.statusCode !== link.statusCode ? body.statusCode : undefined,
      },
    );
  }

  async deleteLink(id: string) {
    await this.dataSource.transaction(async (em) => {
      const linkRepository = em.getRepository(Link);
      const link = await linkRepository.findOneBy({ id });

      if (!link || link.userId !== this.contextService.getRequestUserID()) {
        return;
      }

      await linkRepository.softDelete({ id });

      const linkStatisticsRepository = em.getRepository(LinkStatistics);
      await linkStatisticsRepository.softDelete({ linkId: id });
    });
  }

  private createDeleteCronKey() {
    return ['cron', 'delete-link'].join(':');
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleDeleteCron() {
    await this.timerService.sleep(this.timerService.getRandomSeconds(1, 3));

    const key = this.createDeleteCronKey();

    if (await this.redisService.has(key)) {
      return;
    }

    await this.redisService.setValue(key, {
      processId: this.appConfigFactory.getProcessID(),
      startedAt: new Date(),
    });

    await this.dataSource.transaction(async (em) => {
      const linkRepository = em.getRepository(Link);
      const links = await linkRepository.find({
        select: { id: true },
        where: { expiredAt: And(LessThanOrEqual(new Date())) },
      });

      if (links.length === 0) {
        return;
      }

      const linkIds = links.map((link) => link.id);
      await linkRepository.softDelete({ id: In(linkIds) });

      const linkStatisticsRepository = em.getRepository(LinkStatistics);
      await linkStatisticsRepository.softDelete({ linkId: In(linkIds) });
    });

    await this.redisService.removeValue(key);
  }
}
