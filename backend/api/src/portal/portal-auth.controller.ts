import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  portalForgotPasswordSchema,
  portalLoginSchema,
  portalRegisterSchema,
  resetPasswordSchema,
  type AuthenticatedUser,
  type LoginResponse,
  type PortalForgotPasswordInput,
  type PortalLoginInput,
  type PortalRegisterInput,
  type ResetPasswordInput,
} from '@digisoft/shared';
import { Public } from '../common/decorators/public.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AppConfig } from '../config/config.module';
import { AppError } from '../common/errors/app-error';
import { AuthService, type RequestMeta, type SessionResult } from '../auth/auth.service';
import { CurrentHelpCenter, PortalAuth, PortalGuard, PortalOpen, PortalUser } from './portal.guard';
import { PortalAuthService } from './portal-auth.service';
import type { PortalHelpCenter } from './portal.types';

/** The portal's own refresh cookie, scoped to one help center's auth routes. */
export const PORTAL_REFRESH_COOKIE = 'ds_portal_refresh';

/**
 * Customer sessions. Token issue and rotation are the agent implementation's, but the
 * refresh cookie is the portal's own — its own name, scoped to this help center's auth
 * path — so a customer session and an agent session in the same browser never
 * overwrite each other, and a portal cookie is only ever renewed as a customer of this
 * organization (`POST portal/:slug/auth/refresh`).
 */
@Public()
@UseGuards(PortalGuard)
@Controller('portal/:slug/auth')
export class PortalAuthController {
  constructor(
    private readonly portalAuth: PortalAuthService,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @PortalOpen()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Body(zodBody(portalRegisterSchema)) dto: PortalRegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const session = await this.portalAuth.register(helpCenter, dto, this.meta(req));
    return this.respondWithSession(res, helpCenter, session);
  }

  @PortalOpen()
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Body(zodBody(portalLoginSchema)) dto: PortalLoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const session = await this.portalAuth.login(helpCenter, dto, this.meta(req));
    return this.respondWithSession(res, helpCenter, session);
  }

  @PortalOpen()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const raw = (req.cookies as Record<string, string> | undefined)?.[PORTAL_REFRESH_COOKIE];
    if (!raw) {
      throw AppError.unauthenticated('No active session', 'TOKEN_EXPIRED');
    }
    const session = await this.auth.refresh(raw, this.meta(req), {
      organizationId: helpCenter.organizationId,
      type: 'CUSTOMER',
    });
    return this.respondWithSession(res, helpCenter, session);
  }

  @PortalOpen()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    await this.auth.logout((req.cookies as Record<string, string> | undefined)?.[PORTAL_REFRESH_COOKIE]);
    res.clearCookie(PORTAL_REFRESH_COOKIE, this.cookieOptions(helpCenter, 0));
    return { loggedOut: true };
  }

  @PortalOpen()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Body(zodBody(portalForgotPasswordSchema)) dto: PortalForgotPasswordInput,
  ): Promise<{ requested: true }> {
    await this.portalAuth.forgotPassword(helpCenter, dto.email);
    return { requested: true };
  }

  /**
   * Consumes the token from a customer's reset email. Unlike the agent route this is not
   * switched off by SSO-only mode (customers keep passwords) and accepts only PASSWORD_RESET
   * tokens of customers of this help center.
   */
  @PortalOpen()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Body(zodBody(resetPasswordSchema)) dto: ResetPasswordInput,
  ): Promise<{ reset: true }> {
    await this.portalAuth.resetPassword(helpCenter, dto);
    return { reset: true };
  }

  @PortalAuth()
  @Get('me')
  me(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
  ) {
    return this.portalAuth.profile(helpCenter.organizationId, user!.id);
  }

  private respondWithSession(
    res: Response,
    helpCenter: PortalHelpCenter,
    session: SessionResult,
  ): LoginResponse {
    const maxAge = session.refreshTokenExpiresAt.getTime() - Date.now();
    res.cookie(PORTAL_REFRESH_COOKIE, session.refreshToken, this.cookieOptions(helpCenter, maxAge));
    return {
      status: 'authenticated',
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  private cookieOptions(helpCenter: PortalHelpCenter, maxAge: number) {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'lax' as const,
      domain: this.config.get('COOKIE_DOMAIN'),
      path: `/${this.config.get('API_PREFIX')}/portal/${helpCenter.slug}/auth`,
      maxAge,
    };
  }

  private meta(req: Request): RequestMeta {
    return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
  }
}
