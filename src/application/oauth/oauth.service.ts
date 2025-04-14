import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';
import * as qs from 'qs';

import { KakaoApiService } from 'src/external/kakao-api/kakao-api.service';
import { NaverApiService } from 'src/external/naver-api/naver-api.service';
import { GoogleApiService } from 'src/external/google-api/google-api.service';

import { User } from '../user/entities/user.entity';
import { UserSpecification } from '../user/entities/user-specification.entity';
import { AuthService } from '../auth/auth.service';

import { OAuth } from './entities/oauth.entity';
import { OAuthProfileResponse } from './persistents/types';
import { OAuthPlatform } from './persistents/enums';
import { OAuthProfile } from './persistents/oauth-profile';
import { GetOAuthLoginUrlBodyDTO, GetOAuthLoginUrlResultDTO } from './dto/get-oauth-login-url.dto';
import { ProcessOAuthLoginCallbackQueryDTO } from './dto/process-oauth-login-callback.dto';
import { GetOAuthConnectUrlBodyDTO } from './dto/get-oauth-connect-url.dto';

@Injectable()
export class OAuthService {
  constructor(
    private readonly kakaoApiService: KakaoApiService,
    private readonly naverApiService: NaverApiService,
    private readonly googleApiService: GoogleApiService,
    private readonly authService: AuthService,
    @InjectRepository(OAuth)
    private readonly oauthRepository: Repository<OAuth>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  private getOAuthApiService(platform: OAuthPlatform) {
    switch (platform) {
      case OAuthPlatform.Kakao:
        return this.kakaoApiService;

      case OAuthPlatform.Naver:
        return this.naverApiService;

      case OAuthPlatform.Google:
        return this.googleApiService;
    }
  }

  private async findOrCreateOAuth(platform: OAuthPlatform, profile: OAuthProfileResponse) {
    const oauthProfile = OAuthProfile.of(platform, profile);

    const existOAuth = await this.oauthRepository.findOne({
      relations: { user: true },
      where: { platform, accountId: oauthProfile.accountId },
    });

    if (existOAuth?.user) {
      return existOAuth;
    }

    let user = await this.userRepository.findOneBy({ email: oauthProfile.email });

    if (!user) {
      user = await this.userRepository.save({ email: oauthProfile.email, specification: new UserSpecification() });
    }

    const oauth = await this.oauthRepository.save({
      accountId: oauthProfile.accountId,
      platform: oauthProfile.platform,
      nickname: oauthProfile.nickname,
      name: oauthProfile.name,
      email: oauthProfile.email,
      profileImage: oauthProfile.profileImage,
      user,
    });

    oauth.user = user;

    return oauth;
  }

  private async createSignUrl(oauth: OAuth, redirectUrl: string) {
    const accessToken = this.authService.issueAccessToken(oauth.userId, String(oauth.platform), oauth.accountId);
    const refreshToken = this.authService.issueRefreshToken(accessToken);
    const authKey = await this.authService.setAuthToken(accessToken, refreshToken);

    return [redirectUrl, qs.stringify({ authKey })].join('?');
  }

  // TODO state를 json stringify 형태로 변경
  getLoginUrl(platform: OAuthPlatform, body: GetOAuthLoginUrlBodyDTO): GetOAuthLoginUrlResultDTO {
    return new GetOAuthLoginUrlResultDTO(this.getOAuthApiService(platform).getLoginPageURL(body.callbackUrl));
  }

  // TODO state를 json stringify 형태로 변경
  getConnectUrl(platform: OAuthPlatform, body: GetOAuthConnectUrlBodyDTO): GetOAuthLoginUrlResultDTO {
    return new GetOAuthLoginUrlResultDTO(this.getOAuthApiService(platform).getLoginPageURL(body.callbackUrl));
  }

  async processLoginCallback(platform: OAuthPlatform, query: ProcessOAuthLoginCallbackQueryDTO) {
    const oauthApiService = this.getOAuthApiService(platform);
    const oauthToken = await oauthApiService.getLoginToken(query.code, query.state);
    const oauthProfile = await oauthApiService.getProfile(oauthToken.access_token);
    const oauth = await this.findOrCreateOAuth(platform, oauthProfile);

    return this.createSignUrl(oauth, query.state);
  }
}
