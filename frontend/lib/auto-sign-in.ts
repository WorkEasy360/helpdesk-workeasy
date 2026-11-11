import type { AuthMethods } from '@digisoft/shared';
import { workeasy360StartUrl } from '@/lib/sso';

/**
 * Opening Easy Help Desk directly (Workeasy360 integration guide section 6b).
 *
 * A person who is signed in to Workeasy360 and types the Help Desk's address must arrive
 * signed in, without the Help Desk's sign-in page. When this deployment is SSO-only, an agent
 * app page opened with no session at all therefore goes straight to the API's start route, and
 * Workeasy360 completes it, asks, or shows its own sign-in.
 *
 * Three things keep that from ever being a trap. The two cookies are plain cookies on this
 * app's origin, so every tab sees them:
 *
 * - the sign-in page never starts anything (it does not call this module at all);
 * - `hd_signed_out`, a SESSION cookie (no Max-Age, gone when the browser closes), is written
 *   by both sign-outs BEFORE the sign-out request is sent, so no other tab can start a
 *   sign-in in the gap. It is cleared only by a real sign-in: the API's Workeasy360 callback
 *   (Set-Cookie on success) and the password form (`completeSignIn`). A refresh that merely
 *   succeeded does not clear it. While it stands, a visit shows the sign-in page, so signing
 *   out never ends in a silent sign-in;
 * - `hd_w360_auto` is the loop guard: written right before an automatic start, it makes a
 *   second one within 60 seconds impossible, so a dropped cookie or a failure that is not an
 *   `sso_error` shows the sign-in page instead of spinning.
 *
 * Over https both are `__Host-` cookies (Secure, Path=/, never a Domain), which a sibling
 * subdomain cannot shadow. Over http they keep their plain names, and every copy is read: the
 * marker is set if any copy is set, the guard is active if any copy is recent.
 *
 * Neither cookie grants anything: removing either only makes a start more or less likely.
 */
const SIGNED_OUT_BASE = 'hd_signed_out';
const AUTO_START_BASE = 'hd_w360_auto';
export const AUTO_START_WINDOW_MS = 60_000;

/** The marker's name: `__Host-` over https, plain over http. The API clears the same names. */
export function signedOutCookieName(secure: boolean): string {
  return secure ? `__Host-${SIGNED_OUT_BASE}` : SIGNED_OUT_BASE;
}

/** The loop guard's name: `__Host-` over https, plain over http. */
export function autoStartCookieName(secure: boolean): string {
  return secure ? `__Host-${AUTO_START_BASE}` : AUTO_START_BASE;
}

/** The slice of the browser this module needs, so it can be driven without one. */
export interface CookieEnv {
  /** `document.cookie` */
  read(): string;
  /** Assigns one cookie string, as `document.cookie = ...` does. */
  write(cookie: string): void;
  now(): number;
  /** The page is served over https: cookies are written `Secure`. */
  secure: boolean;
}

export function browserCookieEnv(): CookieEnv | null {
  if (typeof document === 'undefined') return null;
  return {
    read: () => document.cookie,
    write: (cookie) => {
      document.cookie = cookie;
    },
    now: () => Date.now(),
    secure: window.location.protocol === 'https:',
  };
}

/** The value of EVERY cookie with this name: duplicates (other paths or domains) all count. */
function readCookies(env: CookieEnv, name: string): string[] {
  const values: string[] = [];
  for (const part of env.read().split(';')) {
    const entry = part.trim();
    if (entry.startsWith(`${name}=`)) values.push(entry.slice(name.length + 1));
  }
  return values;
}

function writeCookie(env: CookieEnv, name: string, value: string, maxAgeSeconds?: number): void {
  // No Domain, ever: a `__Host-` cookie may not have one, and a host-only cookie cannot be
  // planted from, or leak to, a sibling subdomain.
  const attributes = ['Path=/', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${maxAgeSeconds}`);
  if (env.secure) attributes.push('Secure');
  env.write(`${name}=${value}; ${attributes.join('; ')}`);
}

/**
 * Both sign-outs call this BEFORE the sign-out request is sent: from then on no tab of this
 * browser starts a sign-in, whatever the request ends up doing.
 */
export function markSignedOut(env: CookieEnv | null = browserCookieEnv()): void {
  if (env) writeCookie(env, signedOutCookieName(env.secure), '1');
}

/** Takes the marker back: only when the server clearly said the person is still signed in. */
export function clearSignedOutMarker(env: CookieEnv | null = browserCookieEnv()): void {
  if (env) writeCookie(env, signedOutCookieName(env.secure), '', 0);
}

/** A session exists, so the loop guard has nothing left to guard. Leaves the marker alone. */
export function clearLoopGuard(env: CookieEnv | null = browserCookieEnv()): void {
  if (env) writeCookie(env, autoStartCookieName(env.secure), '', 0);
}

/**
 * A person just signed in with a password (or registered): the marker and the loop guard are
 * spent. The Workeasy360 callback clears the marker on the API's side (Set-Cookie); nothing
 * else - least of all a refresh that happened to succeed - may clear it.
 */
export function completeSignIn(env: CookieEnv | null = browserCookieEnv()): void {
  clearSignedOutMarker(env);
  clearLoopGuard(env);
}

/** The marker is set if ANY copy of it says so. */
export function isSignedOutMarked(env: CookieEnv): boolean {
  return readCookies(env, signedOutCookieName(env.secure)).some((value) => value === '1');
}

/** True when this browser started automatically less than 60 seconds ago (ANY copy being recent counts). */
export function isLoopGuardActive(env: CookieEnv): boolean {
  const now = env.now();
  return readCookies(env, autoStartCookieName(env.secure)).some((raw) => {
    const stamp = Number(raw);
    if (!Number.isFinite(stamp) || stamp <= 0) return false;
    // A clock that moved backwards counts as "just now": the guard errs towards the sign-in page.
    return now - stamp < AUTO_START_WINDOW_MS;
  });
}

/**
 * SSO-only as `GET /auth/methods` reports it: Workeasy360 is the only way in. Anything else -
 * including no answer at all, which the sign-in page treats as "show the password form" - is
 * not SSO-only.
 */
export function isSsoOnly(methods: Pick<AuthMethods, 'password' | 'workeasy360'> | null | undefined): boolean {
  return methods?.workeasy360 === true && methods.password === false;
}

/** The sign-in pages. Same list as the API's `next` validation: none of them is an app page. */
const AUTH_PAGES = /^\/(login|register|forgot-password|reset-password|verify-email|access-ended)(?:[/?#]|$)/;
const PROBE_ORIGIN = 'http://same-site.invalid';
const BACKSLASH = 0x5c;

/**
 * A page address that may be handed to the start route as `next`: the API's own rule, applied
 * here too so a hostile address is never forwarded in the first place. A same-site path with
 * no whitespace, control character or backslash (a browser strips a tab and reads a backslash
 * as a slash, so `/<tab>/evil.example` would become `//evil.example`), at most 2,048
 * characters, which is neither a sign-in page nor the API.
 */
export function isSafeNextPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === BACKSLASH) return false;
    if (code >= 0x80 && code <= 0x9f) return false;
    if (code >= 0x80 && value.charAt(index).trim() === '') return false;
  }
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return false;
  }
  if (resolved.origin !== PROBE_ORIGIN || resolved.pathname.startsWith('//')) return false;
  if (AUTH_PAGES.test(value) || value.startsWith('/api/') || value === '/api') return false;
  return true;
}

export type AutoStartRefusal =
  /** Not SSO-only, or `/auth/methods` could not be read: the sign-in page offers the choice. */
  | 'not_sso_only'
  /** The sign-in page itself, whatever its query. */
  | 'sign_in_page'
  /** The person signed out of the Help Desk in this browser and has not signed in since. */
  | 'signed_out'
  /** An automatic start less than 60 seconds ago left no session. */
  | 'recently_started'
  /** Cookies cannot be written, so the loop guard could not be kept: never start blind. */
  | 'cannot_remember'
  | 'no_browser';

export type AutoStartDecision = { start: true; url: string } | { start: false; reason: AutoStartRefusal };

/**
 * Decides whether the page the person opened should start Workeasy360 sign-in by itself, and
 * if so records the loop guard (so call it only when the answer will be acted on, in the same
 * turn). The caller has already established there is NO session at all - a refresh answered
 * 401. A session that exists but whose access ended, or that must sign in again, never gets
 * here: that is what the access-ended and sign-in-required screens are for.
 *
 * `page` is the address the person opened (path and query). The organization is never named:
 * Workeasy360 shows its own chooser if the person belongs to several.
 */
export function beginAutoStart({
  methods,
  page,
  env = browserCookieEnv(),
}: {
  methods: Pick<AuthMethods, 'password' | 'workeasy360'> | null | undefined;
  page: string;
  env?: CookieEnv | null;
}): AutoStartDecision {
  if (!env) return { start: false, reason: 'no_browser' };
  if (!isSsoOnly(methods)) return { start: false, reason: 'not_sso_only' };
  if (AUTH_PAGES.test(page)) return { start: false, reason: 'sign_in_page' };
  if (isSignedOutMarked(env)) return { start: false, reason: 'signed_out' };
  if (isLoopGuardActive(env)) return { start: false, reason: 'recently_started' };

  writeCookie(env, autoStartCookieName(env.secure), String(env.now()), AUTO_START_WINDOW_MS / 1000);
  if (!isLoopGuardActive(env)) return { start: false, reason: 'cannot_remember' };

  return { start: true, url: startUrlFor(page) };
}

/** The API's start route for an opened page: `next` is the page when it passes, else left out. */
export function startUrlFor(page: string): string {
  return workeasy360StartUrl({ next: isSafeNextPath(page) ? page : null });
}

/** The sign-in page, carrying the opened page when it passes (a full navigation: it starts nothing). */
export function signInPageFor(page: string): string {
  return isSafeNextPath(page) ? `/login?next=${encodeURIComponent(page)}` : '/login';
}
