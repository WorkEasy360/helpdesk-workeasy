import type { AuthenticatedUser } from '@digisoft/shared';
import type { AccessTokenPayload } from '../auth/token.service';
import type { PortalHelpCenter } from '../portal/portal.types';

declare global {
  namespace Express {
    interface Request {
      /** Verified access-token claims of an open session, set by TenantContextMiddleware. */
      accessTokenPayload?: AccessTokenPayload;
      /**
       * Why the bearer token was rejected, so the guard can answer precisely: `ended` when it
       * verifies but its session has ended (or it names none), `disabled` when its account is
       * deactivated or deleted, `unverified` when the session could not be checked (the database
       * did not answer).
       */
      authError?: 'expired' | 'invalid' | 'ended' | 'disabled' | 'unverified';
      /** Effective identity, resolved by JwtAuthGuard or, on portal routes, PortalGuard. */
      user?: AuthenticatedUser;
      /** Help center addressed by a /portal/:slug route, set by PortalContextMiddleware. */
      helpCenter?: PortalHelpCenter;
      /** Exact request bytes, kept by Nest's rawBody option so webhook signatures verify. */
      rawBody?: Buffer;
      /** True when the identity came from an API key rather than a bearer token. */
      apiKeyAuthenticated?: boolean;
    }
  }
}

export {};
