import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Workeasy360SsoErrorCode } from '@digisoft/shared';
import { Workeasy360Error, safeEqual } from '@digisoft/workeasy360';
import { Public } from '../common/decorators/public.decorator';
import { WORKEASY360_ROUTE_BASE } from '../common/app-prefix';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AuthService } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import { readRefreshCookie, setRefreshCookie } from '../auth/session-cookie';
import { FLOW_TTL_SECONDS, FlowStore } from './flow.store';
import { overLimit } from './rate-limit';
import { safeNext } from './safe-next';
import { SsoRefusal, codeForClientError, codeForProviderError } from './sso-errors';
import { Workeasy360ClientProvider } from './workeasy360-client.provider';
import { Workeasy360ProvisioningService } from './workeasy360-provisioning.service';
import { Workeasy360Settings } from './workeasy360.settings';
import { EntitlementService } from './entitlement.service';

/**
 * The flow cookie: a random id, scoped to the callback, good for the life of one flow.
 *
 * With COOKIE_SECURE on it is `__Secure-ds_w360_flow`. The stricter `__Host-` prefix would
 * need `Path=/`, and this cookie is deliberately confined to the callback path
 * (`/api/auth/callback`) so it is never sent anywhere else; `__Secure-` still makes a
 * browser refuse to set or accept it over plain http.
 */
export const FLOW_COOKIE = 'ds_w360_flow';
export const SECURE_FLOW_COOKIE = `__Secure-${FLOW_COOKIE}`;
const FLOW_COOKIE_PATH = `/${WORKEASY360_ROUTE_BASE}/callback`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CODE = 2048;
const MAX_STATE = 512;

/**
 * The browser-facing half of "Sign in with Workeasy360": plain GET navigations that answer
 * with redirects (the page's CSP allows no cross-origin fetch or form post, and none is
 * needed). They live under `/api/auth`, outside the versioned prefix, because the callback's
 * address is registered with Workeasy360 and the reverse proxy already routes `/api/` here.
 *
 * `start`     keeps state, nonce and the PKCE verifier on the server (Redis, single use,
 *             10 minutes), puts a random flow id in an httpOnly cookie and redirects to Workeasy360.
 * `callback`  consumes the flow first, whatever happens next; compares the state in constant
 *             time; exchanges the code with private_key_jwt; verifies the ID token; provisions;
 *             ends any session the browser already holds; issues a fresh one; lands on `next`.
 * `logout`    sends the browser on to Workeasy360's sign-out confirmation. Changes nothing here.
 *
 * CSRF: the callback is protected by state (bound to this browser by the flow cookie), nonce
 * (bound to the ID token) and PKCE (bound to the code), as OAuth requires. Failures redirect
 * to `/login?sso_error=<code>` with a code from a fixed vocabulary; details go to the log,
 * never a code, token, state or nonce.
 */
@Public()
@SkipThrottle({ default: true, auth: true })
@Controller(WORKEASY360_ROUTE_BASE)
export class Workeasy360AuthController {
  private readonly logger = new Logger(Workeasy360AuthController.name);
  private readonly flows: FlowStore;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfig,
    private readonly settings: Workeasy360Settings,
    private readonly clients: Workeasy360ClientProvider,
    private readonly provisioning: Workeasy360ProvisioningService,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {
    this.flows = new FlowStore(redis);
  }

  @Get('workeasy360/start')
  async start(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.noStore(res);
    if (!this.settings.configured) {
      return this.fail(res, 'unavailable', 'not configured');
    }
    if (await this.rateLimited(req, 'start')) {
      return this.fail(res, 'rate_limited', 'start');
    }

    const organization = typeof req.query['organization'] === 'string' ? req.query['organization'] : '';
    // The launcher's organization is forwarded only when it is a UUID; anything else is
    // dropped and Workeasy360 shows its own chooser.
    const forwarded = UUID.test(organization) ? organization.toLowerCase() : '';
    const next = safeNext(req.query['next']);

    try {
      const request = await this.clients.get().authorizationRequest(forwarded ? { organizationId: forwarded } : {});
      const flowId = this.flows.newFlowId();
      await this.flows.save(flowId, {
        state: request.state,
        nonce: request.nonce,
        verifier: request.codeVerifier,
        organization: forwarded,
        next,
      });
      res.cookie(this.flowCookieName, flowId, this.flowCookieOptions(FLOW_TTL_SECONDS * 1000));
      res.redirect(302, request.url);
    } catch (error) {
      this.fail(res, this.codeFor(error), this.describe(error));
    }
  }

  @Get('callback/workeasy360')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.noStore(res);
    // The flow is single use: consumed (and its cookie dropped) before anything is checked.
    res.clearCookie(this.flowCookieName, this.flowCookieOptions(0));
    const cookies = req.cookies as Record<string, string> | undefined;
    const flowId = cookies?.[this.flowCookieName];
    let flow = null;
    try {
      flow = typeof flowId === 'string' ? await this.flows.consume(flowId) : null;
    } catch (error) {
      // Redis unavailable: the sign-in cannot complete, and the browser is told so plainly.
      return this.fail(res, 'unavailable', this.describe(error));
    }

    if (await this.rateLimited(req, 'callback')) {
      return this.fail(res, 'rate_limited', 'callback');
    }

    const state = typeof req.query['state'] === 'string' ? req.query['state'].slice(0, MAX_STATE) : '';
    const providerError = typeof req.query['error'] === 'string' ? req.query['error'].slice(0, 64) : '';
    if (providerError) {
      return this.fail(res, codeForProviderError(providerError), `provider returned error=${providerError}`);
    }
    if (!flow) {
      return this.fail(res, 'expired', 'no pending flow for this browser');
    }
    if (!state || !safeEqual(state, flow.state)) {
      return this.fail(res, 'expired', 'state does not match the pending flow');
    }
    if (!this.settings.configured) {
      return this.fail(res, 'unavailable', 'not configured');
    }
    const code = typeof req.query['code'] === 'string' ? req.query['code'].slice(0, MAX_CODE + 1) : '';
    if (!code || code.length > MAX_CODE) {
      return this.fail(res, 'refused', 'no usable code');
    }

    try {
      const client = this.clients.get();
      const claims = await client.complete({
        code,
        returnedState: state,
        expectedState: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.verifier,
      });

      // The audience check already ties the token to our client id; this catches a client id
      // registered to the wrong product.
      if (claims.product_code !== this.settings.productCode) {
        throw new SsoRefusal('wrong_product', `token is for ${String(claims.product_code)}`);
      }
      if (flow.organization && String(claims.organization_id).toLowerCase() !== flow.organization) {
        // The launcher asked for one organization and the provider answered for another:
        // land nowhere rather than in the wrong helpdesk.
        throw new SsoRefusal('wrong_organization', 'organization_id differs from the launcher');
      }

      const signedIn = await this.provisioning.provision(claims, client.issuer);

      // Account switching and fixation: whatever session this browser already holds ends here,
      // server-side. The new session gets a fresh family; the presented one is never reused.
      await this.endPresentedSession(req);

      const meta = { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
      const session = await this.auth.createSession(
        signedIn.userId,
        signedIn.organizationId,
        meta,
        undefined,
        'WORKEASY360',
      );
      await this.entitlements.forgetLink(signedIn.organizationId);
      setRefreshCookie(res, this.config, session.refreshToken, session.refreshTokenExpiresAt);
      this.logger.log({
        msg: 'workeasy360.sign_in',
        organizationId: signedIn.organizationId,
        userId: signedIn.userId,
        organizationCreated: signedIn.organizationCreated,
        linked: signedIn.linked,
        userCreated: signedIn.userCreated,
      });
      res.redirect(302, `${this.frontendOrigin}${flow.next}`);
    } catch (error) {
      this.fail(res, this.codeFor(error), this.describe(error));
    }
  }

  /**
   * "Sign out of Easy Help Desk and Workeasy360": the app ends its own session first (a
   * CSRF-protected POST), then navigates here. This only sends the browser on to Workeasy360,
   * which asks the person to confirm before signing anyone out and returns them to the
   * registered post-logout URI. It changes nothing locally, so a link to it cannot sign anyone
   * out of Help Desk.
   */
  @Get('workeasy360/logout')
  async logout(@Res() res: Response): Promise<void> {
    this.noStore(res);
    const fallback = `${this.frontendOrigin}/login`;
    if (!this.settings.signOutAvailable) {
      return res.redirect(302, fallback);
    }
    try {
      const target = await this.clients.get().endSessionUrl(this.settings.postLogoutRedirectUri);
      res.redirect(302, target || fallback);
    } catch (error) {
      this.logger.warn({ msg: 'workeasy360.end_session_failed', code: this.codeFor(error), detail: this.describe(error) });
      res.redirect(302, fallback);
    }
  }

  // --- helpers -----------------------------------------------------------

  private get frontendOrigin(): string {
    return new URL(this.config.get('FRONTEND_URL')).origin;
  }

  private noStore(res: Response): void {
    res.set('Cache-Control', 'no-store');
  }

  private get flowCookieName(): string {
    return this.config.get('COOKIE_SECURE') ? SECURE_FLOW_COOKIE : FLOW_COOKIE;
  }

  private flowCookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'lax' as const,
      path: FLOW_COOKIE_PATH,
      maxAge,
    };
  }

  /** Revokes the family of the refresh cookie this browser presented, if it is one of ours. */
  private async endPresentedSession(req: Request): Promise<void> {
    const raw = readRefreshCookie(req);
    if (!raw) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(raw) },
      select: { familyId: true },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private fail(res: Response, code: Workeasy360SsoErrorCode, detail: string): void {
    // Codes and ids only: never an authorization code, token, state or nonce.
    this.logger.warn({ msg: 'workeasy360.sign_in_failed', code, detail });
    // A failed callback must also drop any half-way state; the cookie is already cleared.
    res.redirect(302, `${this.frontendOrigin}/login?sso_error=${encodeURIComponent(code)}`);
  }

  private codeFor(error: unknown): Workeasy360SsoErrorCode {
    if (error instanceof SsoRefusal) return error.code;
    if (error instanceof Workeasy360Error) return codeForClientError(error);
    return 'unavailable';
  }

  /** What is safe to log about a failure: our own codes and details, or just the error type. */
  private describe(error: unknown): string {
    if (error instanceof SsoRefusal || error instanceof Workeasy360Error) return error.detail;
    return error instanceof Error ? error.name : 'unknown';
  }

  private async rateLimited(req: Request, kind: 'start' | 'callback'): Promise<boolean> {
    if (!this.config.get('THROTTLE_ENABLED')) return false;
    const address = createHash('sha256').update(req.ip ?? 'unknown').digest('hex').slice(0, 24);
    const key = `w360:rl:${kind}:${address}`;
    try {
      return await overLimit(this.redis, key, this.config.get('WORKEASY360_SIGN_IN_RATE_LIMIT'));
    } catch {
      return false;
    }
  }
}
