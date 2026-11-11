import {
  WORKEASY360_SSO_ERROR_CODES,
  type Workeasy360AccessErrorCode,
  type Workeasy360SsoErrorCode,
} from '@digisoft/shared';
import { API_URL } from '@/lib/env';

/**
 * "Sign in with Workeasy360" lives in the API, outside the versioned prefix: its routes are
 * plain browser navigations (redirects), at `<API origin>/api/auth/...`. In production that
 * is the same host as the app; in development it is the API's own origin.
 */
export const API_ORIGIN = new URL(API_URL).origin;

export const WORKEASY360_START_PATH = '/api/auth/workeasy360/start';
export const WORKEASY360_LOGOUT_PATH = '/api/auth/workeasy360/logout';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Where "Continue with Workeasy360" goes: a link, not a fetch. `next` is where the person
 * lands afterwards; the API validates it again and refuses anything off-site.
 */
export function workeasy360StartUrl(
  options: { next?: string | null; organization?: string | null } = {},
): string {
  const url = new URL(WORKEASY360_START_PATH, API_ORIGIN);
  if (isUuid(options.organization))
    url.searchParams.set('organization', options.organization.toLowerCase());
  if (options.next) url.searchParams.set('next', options.next);
  return url.toString();
}

/** Where "Sign out of Easy Help Desk and Workeasy360" sends the browser once the local session has ended. */
export function workeasy360LogoutUrl(): string {
  return new URL(WORKEASY360_LOGOUT_PATH, API_ORIGIN).toString();
}

const SSO_ERROR_MESSAGES: Record<Workeasy360SsoErrorCode, string> = {
  cancelled: 'Sign-in was cancelled. You were not signed in.',
  expired: 'That sign-in took too long or was already used. Start again.',
  unavailable: 'Workeasy360 sign-in is not available right now. Please try again shortly.',
  refused: 'Workeasy360 sign-in could not be completed. Please try again.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  not_entitled:
    'Your organization does not have Easy Help Desk, or its trial or plan has ended. Ask an owner to check it in Workeasy360.',
  no_seat:
    'You do not have an Easy Help Desk seat in this organization. Ask an owner to assign one in Workeasy360.',
  provider_membership_inactive:
    'Your Workeasy360 membership in this organization is suspended or removed. Contact an owner.',
  organization_inactive: 'This organization is suspended in Workeasy360.',
  access_policy:
    'A Workeasy360 access policy (network or two-step verification) did not allow this sign-in.',
  email_missing:
    'Workeasy360 did not share an email address for your account, so Easy Help Desk cannot sign you in.',
  email_unverified: 'Verify your email address in Workeasy360, then sign in again.',
  account_conflict:
    'An Easy Help Desk account for this address is already linked to a different Workeasy360 account, or belongs to a customer. Contact your administrator.',
  account_disabled: 'Your Easy Help Desk account is deactivated. Contact your administrator.',
  membership_inactive:
    'Your access to this Easy Help Desk workspace was removed. Contact your administrator.',
  wrong_product:
    'That sign-in was for a different product. Open Easy Help Desk from Workeasy360 and try again.',
  wrong_organization:
    'You signed in to a different organization than the one you opened. Open Easy Help Desk from Workeasy360 and try again.',
};

const FALLBACK_SSO_ERROR = SSO_ERROR_MESSAGES.refused;

/** The message for a `?sso_error=` value, or null when there is none. Unknown values read as "refused". */
export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (WORKEASY360_SSO_ERROR_CODES as readonly string[]).includes(code)
    ? SSO_ERROR_MESSAGES[code as Workeasy360SsoErrorCode]
    : FALLBACK_SSO_ERROR;
}

/** Access-ended screen reasons, keyed by what the API said. */
export type AccessEndedReason = 'ended' | 'read_only' | 'unverified';

export const ACCESS_ERROR_REASONS: Record<Workeasy360AccessErrorCode, AccessEndedReason> = {
  WORKEASY360_ACCESS_ENDED: 'ended',
  WORKEASY360_READ_ONLY: 'read_only',
  WORKEASY360_ACCESS_UNVERIFIED: 'unverified',
};

export function accessEndedPath(code: Workeasy360AccessErrorCode, detail?: unknown): string {
  const params = new URLSearchParams({ reason: ACCESS_ERROR_REASONS[code] });
  const why =
    typeof detail === 'object' && detail !== null && 'reason' in detail
      ? String((detail as { reason: unknown }).reason)
      : '';
  if (/^[a-z_]{1,32}$/.test(why)) params.set('detail', why);
  return `/access-ended?${params.toString()}`;
}

/** The agent's session needs a Workeasy360 sign-in (SSO-only; a password-era session). */
export const SIGN_IN_REQUIRED_CODE = 'WORKEASY360_SIGN_IN_REQUIRED';
export const SIGN_IN_REQUIRED_PATH = '/login?signin=workeasy360';

/**
 * Where a refused agent request or socket goes: the access-ended screen for an ended,
 * read-only or unverified access, the sign-in page for a session that must sign in with
 * Workeasy360. Null for any other code.
 */
export function accessRefusalPath(code: string | undefined, details?: unknown): string | null {
  if (code === SIGN_IN_REQUIRED_CODE) return SIGN_IN_REQUIRED_PATH;
  return isAccessErrorCode(code) ? accessEndedPath(code, details) : null;
}

/**
 * What `POST /auth/refresh` told the page about the agent session:
 * - `ok`: a fresh access token;
 * - `no_session`: the API answered 401 - there is no refresh cookie, or the session is gone.
 *   This is the only answer that means "no session at all";
 * - `sign_in_required`: a password-era session that SSO-only mode refuses (it keeps its
 *   explanation on the sign-in page);
 * - `unavailable`: anything else (an outage, a throttle, a body we cannot read): we do not
 *   know whether a session exists.
 */
export type RefreshOutcome =
  | { kind: 'ok'; token: string }
  | { kind: 'no_session' }
  | { kind: 'sign_in_required' }
  | { kind: 'unavailable' };

/** Classifies a failed refresh by the HTTP status and error code the API answered with. */
export function refreshFailureOutcome(
  status: number | undefined,
  code: string | undefined,
): Exclude<RefreshOutcome, { kind: 'ok' }> {
  if (code === SIGN_IN_REQUIRED_CODE) return { kind: 'sign_in_required' };
  if (status === 401) return { kind: 'no_session' };
  return { kind: 'unavailable' };
}

export function isAccessErrorCode(code: string | undefined): code is Workeasy360AccessErrorCode {
  return code !== undefined && Object.prototype.hasOwnProperty.call(ACCESS_ERROR_REASONS, code);
}
