import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NaverApiConfigFactory {
  constructor(private readonly configService: ConfigService) {}

  public getLoginClientID(): string {
    return this.configService.getOrThrow('NAVER_LOGIN_CLIENT_ID');
  }

  public getLoginClientSecret(): string {
    return this.configService.getOrThrow('NAVER_LOGIN_CLIENT_SECRET');
  }

  public getLoginRedirectURI(): string {
    return this.configService.getOrThrow('NAVER_LOGIN_REDIRECT_URI');
  }
}
