import type { Workeasy360SsoErrorCode } from '@digisoft/shared';
import { WORKEASY360_SSO_ERROR_CODES } from '@digisoft/shared';
import { Workeasy360Error } from '@digisoft/workeasy360';

/** A sign-in that must not complete, with the fixed-vocabulary code the browser is sent. */
export class SsoRefusal extends Error {
  constructor(
    readonly code: Workeasy360SsoErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SsoRefusal';
  }
}

/** OAuth `error` values Workeasy360's authorization endpoint redirects back with. */
export const PROVIDER_ERRORS: Readonly<Record<string, Workeasy360SsoErrorCode>> = {
  access_denied: 'cancelled',
  login_required: 'expired',
  organization_required: 'expired',
  product_not_entitled: 'not_entitled',
  product_no_seat: 'no_seat',
  membership_inactive: 'provider_membership_inactive',
  organization_inactive: 'organization_inactive',
  access_policy_denied: 'access_policy',
  integration_suspended: 'unavailable',
  // Workeasy360 says this product is not registered to use its sign-in (sign_in_mode local_only).
  unauthorized_client: 'unavailable',
  // Only answered to prompt=none, which Help Desk never sends; treated like a lapsed flow.
  interaction_required: 'expired',
  invalid_scope: 'unavailable',
  server_error: 'unavailable',
  temporarily_unavailable: 'unavailable',
};

export function codeForProviderError(error: string): Workeasy360SsoErrorCode {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ERRORS, error) ? PROVIDER_ERRORS[error]! : 'refused';
}

/** The protocol client's errors, mapped to the vocabulary. */
export function codeForClientError(error: Workeasy360Error): Workeasy360SsoErrorCode {
  switch (error.code) {
    case 'provider_unavailable':
    case 'provider_misconfigured':
    case 'provider_refused':
      return 'unavailable';
    case 'rate_limited':
      return 'rate_limited';
    case 'state_mismatch':
      return 'expired';
    default:
      // invalid_token, invalid_request and the routine invalid_grant (the message says "try again").
      return 'refused';
  }
}

export function isSsoErrorCode(value: string): value is Workeasy360SsoErrorCode {
  return (WORKEASY360_SSO_ERROR_CODES as readonly string[]).includes(value);
}
