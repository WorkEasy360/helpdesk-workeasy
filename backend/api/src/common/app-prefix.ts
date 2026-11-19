import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';

/**
 * The Workeasy360 sign-in routes live outside the versioned API prefix: their addresses are
 * registered with Workeasy360 (the redirect URI, the back-channel logout URI) and linked from
 * the app, and the browser ones are plain redirects rather than JSON endpoints. They are always
 * under `/api/auth`, whatever `API_PREFIX` is, so the reverse proxy's `/api/` rule already
 * reaches them.
 */
export const WORKEASY360_ROUTE_BASE = 'api/auth';
export const WORKEASY360_START_PATH = `${WORKEASY360_ROUTE_BASE}/workeasy360/start`;
export const WORKEASY360_CALLBACK_PATH = `${WORKEASY360_ROUTE_BASE}/callback/workeasy360`;
export const WORKEASY360_LOGOUT_PATH = `${WORKEASY360_ROUTE_BASE}/workeasy360/logout`;
/** Server to server: Workeasy360 POSTs a Back-Channel Logout 1.0 logout token here. */
export const WORKEASY360_BACKCHANNEL_LOGOUT_PATH = `${WORKEASY360_ROUTE_BASE}/workeasy360/backchannel-logout`;

/** Applies the global prefix, minus the Workeasy360 sign-in routes. Shared by `main.ts` and the e2e harness. */
export function applyGlobalPrefix(app: INestApplication, prefix: string): void {
  app.setGlobalPrefix(prefix, {
    exclude: [
      { path: WORKEASY360_START_PATH, method: RequestMethod.GET },
      { path: WORKEASY360_CALLBACK_PATH, method: RequestMethod.GET },
      { path: WORKEASY360_LOGOUT_PATH, method: RequestMethod.GET },
      { path: WORKEASY360_BACKCHANNEL_LOGOUT_PATH, method: RequestMethod.POST },
    ],
  });
}
