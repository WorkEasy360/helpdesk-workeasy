import type { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/config.module';

export const REFRESH_COOKIE = 'ds_refresh';
/** Under COOKIE_SECURE (production) the refresh cookie is a `__Host-` cookie; see below. */
export const HOST_REFRESH_COOKIE = `__Host-${REFRESH_COOKIE}`;

/**
 * Over plain http (development, tests) the refresh cookie is `ds_refresh`, scoped to `/api`,
 * not `/api/v1/auth`: the Workeasy360 sign-in callback lives at `/api/auth/callback/workeasy360`
 * (outside the versioned prefix) and has to see the previous session's cookie to end it when a
 * different person signs in on the same browser. It is httpOnly and SameSite=Lax; the portal's
 * customer cookie keeps its own name and narrower path.
 */
export const REFRESH_COOKIE_PATH = '/api';

/**
 * Under COOKIE_SECURE it is `__Host-ds_refresh`: Secure, `Path=/`, and NO Domain. All of the
 * products are siblings under one parent domain, so a compromised sibling can set a cookie with
 * `Domain=.parent` that this origin would receive; a `__Secure-` prefix does not stop that, only
 * `__Host-` does (a browser refuses a `__Host-` cookie that has a Domain, so only this exact
 * host can ever have set it). Planting a refresh cookie would sign the victim in as the attacker,
 * so in that mode ONLY the prefixed name is read: an unprefixed `ds_refresh` is ignored, never
 * trusted. `COOKIE_DOMAIN` therefore does not apply to this cookie.
 */
export function refreshCookieName(config: AppConfig): string {
  return config.get('COOKIE_SECURE') ? HOST_REFRESH_COOKIE : REFRESH_COOKIE;
}

function baseOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.get('COOKIE_SECURE'),
    sameSite: 'lax',
    domain: config.get('COOKIE_DOMAIN'),
  };
}

/** Options of the live cookie: host-only and `Path=/` under COOKIE_SECURE (what `__Host-` demands). */
function currentOptions(config: AppConfig): CookieOptions {
  if (config.get('COOKIE_SECURE')) {
    return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
  }
  return { ...baseOptions(config), path: REFRESH_COOKIE_PATH };
}

/**
 * Before the Workeasy360 release the cookie lived at `/<API_PREFIX>/auth`. A browser that
 * still holds that one would send both on refresh, the old one first, and the replay of the
 * rotated token would revoke the family. Every write therefore also expires the old path.
 */
function legacyPath(config: AppConfig): string {
  return `/${config.get('API_PREFIX')}/auth`;
}

/**
 * Expires what earlier releases may have left in the browser: the unprefixed `ds_refresh` at
 * `/<API_PREFIX>/auth`, and (once COOKIE_SECURE moved the live cookie to `__Host-`) the
 * unprefixed `ds_refresh` at `/api`, which is no longer read and must not linger for 30 days.
 */
function expireOldCookies(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(config), path: legacyPath(config) });
  if (config.get('COOKIE_SECURE')) {
    res.clearCookie(REFRESH_COOKIE, { ...baseOptions(config), path: REFRESH_COOKIE_PATH });
  }
}

export function setRefreshCookie(res: Response, config: AppConfig, token: string, expiresAt: Date): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie(refreshCookieName(config), token, { ...currentOptions(config), maxAge });
  expireOldCookies(res, config);
}

export function clearRefreshCookie(res: Response, config: AppConfig): void {
  res.clearCookie(refreshCookieName(config), currentOptions(config));
  expireOldCookies(res, config);
}

/** The agent refresh token this browser presented, from the one cookie name this deployment trusts. */
export function readRefreshCookie(req: Request, config: AppConfig): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  const value = cookies?.[refreshCookieName(config)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
