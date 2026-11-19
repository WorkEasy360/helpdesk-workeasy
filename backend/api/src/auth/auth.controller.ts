import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateUserSchema,
  verifyEmailSchema,
  type AuthenticatedUser,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginInput,
  type LoginResponse,
  type LoginResult,
  type RegisterInput,
  type AuthMethods,
  type ResetPasswordInput,
  type UpdateUserInput,
  type VerifyEmailInput,
} from '@digisoft/shared';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AppError } from '../common/errors/app-error';
import { EntitlementExempt } from '../common/decorators/entitlement.decorator';
import { AppConfig } from '../config/config.module';
import { Workeasy360Settings } from '../workeasy360/workeasy360.settings';
import { AuthService, type RequestMeta, type SessionResult } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './session-cookie';

export { REFRESH_COOKIE } from './session-cookie';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly workeasy360: Workeasy360Settings,
  ) {}

  /** Which sign-in methods the login page should offer. */
  @Public()
  @Get('methods')
  methods(): AuthMethods {
    return this.workeasy360.methods();
  }

  /** Lets the sign-up page know whether to offer organization registration at all. */
  @Public()
  @Get('register')
  registrationStatus(): { enabled: boolean } {
    // With Workeasy360 as the only way in, organizations arrive through their first sign-in.
    return { enabled: this.config.get('ALLOW_PUBLIC_REGISTRATION') && !this.workeasy360.ssoOnly };
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) dto: RegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    this.workeasy360.assertPasswordSignInAllowed();
    // Self-hosted and invite-only deployments turn off creating new organizations.
    if (!this.config.get('ALLOW_PUBLIC_REGISTRATION')) {
      throw AppError.forbidden('New organization sign-up is disabled', 'REGISTRATION_DISABLED');
    }
    const session = await this.auth.register(dto, this.meta(req));
    return this.respondWithSession(res, session);
  }

  @Public()
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body(zodBody(loginSchema)) dto: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    this.workeasy360.assertPasswordSignInAllowed();
    const result = await this.auth.login(dto, this.meta(req));
    // The same credentials matched more than one organization: hand back the choices
    // rather than a session — no token is issued and no cookie is set until the caller
    // resubmits with organizationSlug set to one of them.
    if (result.status === 'choose_organization') {
      return result;
    }
    return this.respondWithSession(res, result);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const raw = readRefreshCookie(req, this.config);
    if (!raw) {
      throw AppError.unauthenticated('No active session', 'TOKEN_EXPIRED');
    }
    const session = await this.auth.refresh(raw, this.meta(req));
    return this.respondWithSession(res, session);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    await this.auth.logout(readRefreshCookie(req, this.config));
    clearRefreshCookie(res, this.config);
    return { loggedOut: true };
  }

  /** Stays available after Workeasy360 access ended, so the person can see why and sign out. */
  @EntitlementExempt()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /** Any signed-in user may edit their own name, phone and avatar; nothing else. */
  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(updateUserSchema)) dto: UpdateUserInput,
  ): Promise<AuthenticatedUser> {
    return this.auth.updateProfile(user, dto);
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(
    @Body(zodBody(forgotPasswordSchema)) dto: ForgotPasswordInput,
  ): Promise<{ requested: true }> {
    this.workeasy360.assertPasswordSignInAllowed();
    await this.auth.forgotPassword(dto);
    return { requested: true };
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) dto: ResetPasswordInput,
  ): Promise<{ reset: true }> {
    this.workeasy360.assertPasswordSignInAllowed();
    await this.auth.resetPassword(dto);
    return { reset: true };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmail(
    @Body(zodBody(verifyEmailSchema)) dto: VerifyEmailInput,
  ): Promise<{ verified: true }> {
    await this.auth.verifyEmail(dto.token);
    return { verified: true };
  }

  @Throttle({ auth: { limit: 3, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ requested: true }> {
    await this.auth.sendEmailVerification(user.id);
    return { requested: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(changePasswordSchema)) dto: ChangePasswordInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ changed: true }> {
    this.workeasy360.assertPasswordSignInAllowed();
    await this.auth.changePassword(user.id, user.organizationId, dto);
    clearRefreshCookie(res, this.config);
    return { changed: true };
  }

  private respondWithSession(res: Response, session: SessionResult): LoginResponse {
    setRefreshCookie(res, this.config, session.refreshToken, session.refreshTokenExpiresAt);
    return {
      status: 'authenticated',
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  private meta(req: Request): RequestMeta {
    return {
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
  }
}
