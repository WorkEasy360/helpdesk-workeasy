import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  Workeasy360Error,
  type VerifiedLogoutToken,
  type Workeasy360Client,
} from '@digisoft/workeasy360';
import { Public } from '../common/decorators/public.decorator';
import { WORKEASY360_ROUTE_BASE } from '../common/app-prefix';
import { BackchannelLogoutService } from './backchannel-logout.service';
import { Workeasy360ClientProvider } from './workeasy360-client.provider';
import { Workeasy360Settings } from './workeasy360.settings';

/** A logout token is a compact JWS of well under 2 KB; anything much larger is not one. */
const MAX_LOGOUT_TOKEN_LENGTH = 16 * 1024;

/**
 * OpenID Connect Back-Channel Logout 1.0, the receiver: `POST /api/auth/workeasy360/backchannel-logout`
 * with the form field `logout_token`. Workeasy360 calls it, server to server, when a sign-in that
 * opened Easy Help Desk ends (sign-out, account switch, a revoked session, "sign out everywhere",
 * a password change or reset).
 *
 * Its address is registered with Workeasy360 (the product's `backchannel_logout_uri`), which
 * requires the origin of a registered redirect URI, so it lives beside the callback under
 * `/api/auth`, outside the versioned prefix, where the reverse proxy already routes.
 *
 * No cookie is read and no CSRF token is asked for: the provider's signature on the token is the
 * authentication. Answers carry `Cache-Control: no-store`:
 *
 * - 200: the token verified and the sessions it names have ended (or had already);
 * - 400 `invalid_request`: the token does not verify, or its `jti` was accepted before. Nothing
 *   ends, and Workeasy360 does not retry a 4xx;
 * - 503 `temporarily_unavailable`: the key set could not be read or ending the sessions failed.
 *   Nothing was recorded, so Workeasy360's retry is accepted;
 * - 404: this deployment does not sign in with Workeasy360.
 */
@Public()
@SkipThrottle({ default: true, auth: true })
@Controller(WORKEASY360_ROUTE_BASE)
export class Workeasy360BackchannelController {
  private readonly logger = new Logger(Workeasy360BackchannelController.name);

  constructor(
    private readonly settings: Workeasy360Settings,
    private readonly clients: Workeasy360ClientProvider,
    private readonly backchannel: BackchannelLogoutService,
  ) {}

  @Post('workeasy360/backchannel-logout')
  async backchannelLogout(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    if (!this.settings.configured) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const raw = req.is('application/x-www-form-urlencoded') ? body?.['logout_token'] : undefined;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LOGOUT_TOKEN_LENGTH) {
      return this.refuse(res, 'no logout_token form field');
    }

    let client: Workeasy360Client;
    let token: VerifiedLogoutToken;
    try {
      client = this.clients.get();
      token = await client.verifyLogoutToken(raw);
    } catch (error) {
      if (error instanceof Workeasy360Error && error.code === 'invalid_token') {
        return this.refuse(res, error.detail);
      }
      // The key set or discovery could not be read, or our client is unusable: not the
      // token's fault, so Workeasy360 is asked to deliver it again.
      return this.unavailable(res, 'workeasy360.logout_token_unverifiable', error);
    }

    try {
      const outcome = await this.backchannel.end(client.issuer, token);
      if (outcome.status === 'replayed') {
        return this.refuse(res, `jti ${token.jti} was already accepted`);
      }
      this.logger.log({
        msg: 'workeasy360.backchannel_logout',
        jti: token.jti,
        by: outcome.by,
        sessionsEnded: outcome.sessions,
      });
      res.status(200).end();
    } catch (error) {
      return this.unavailable(res, 'workeasy360.backchannel_logout_failed', error);
    }
  }

  private refuse(res: Response, detail: string): void {
    // Our own reason only: never the token.
    this.logger.warn({ msg: 'workeasy360.logout_token_rejected', detail });
    res.status(400).json({ error: 'invalid_request' });
  }

  private unavailable(res: Response, msg: string, error: unknown): void {
    const detail =
      error instanceof Workeasy360Error
        ? error.detail || error.code
        : error instanceof Error
          ? error.name
          : 'unknown';
    this.logger.error({ msg, detail });
    res.status(503).json({ error: 'temporarily_unavailable' });
  }
}
