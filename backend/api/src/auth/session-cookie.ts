import type { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/config.module';

export const REFRESH_COOKIE = 'ds_refresh';

/**
 * The refresh cookie is scoped to `/api`, not `/api/v1/auth`: the Workeasy360 sign-in
 * callback lives at `/api/auth/callback/workeasy360` (outside the versioned prefix) and has
 * to see the previous session's cookie to end it when a different person signs in on the
 * same browser. It is httpOnly and SameSite=Lax; the portal's customer cookie keeps its own
 * name and narrower path.
 */
export const REFRESH_COOKIE_PATH = '/api';

function baseOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.get('COOKIE_SECURE'),
    sameSite: 'lax',
    domain: config.get('COOKIE_DOMAIN'),
  };
}

/**
 * Before the Workeasy360 release the cookie lived at `/<API_PREFIX>/auth`. A browser that
 * still holds that one would send both on refresh, the old one first, and the replay of the
 * rotated token would revoke the family. Every write therefore also expires the old path.
 */
function legacyPath(config: AppConfig): string {
  return `/${config.get('API_PREFIX')}/auth`;
}

export function setRefreshCookie(res: Response, config: AppConfig, token: string, expiresAt: Date): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(config), path: REFRESH_COOKIE_PATH, maxAge });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(config), path: legacyPath(config) });
}

export function clearRefreshCookie(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(config), path: REFRESH_COOKIE_PATH });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(config), path: legacyPath(config) });
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
