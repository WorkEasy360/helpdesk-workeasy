/**
 * Why a Workeasy360 call did not produce an answer. The code is a fixed vocabulary that
 * callers map to what they show a browser; `detail` is for logs only and may name
 * internals, so it is never sent to a browser.
 */
export type Workeasy360ErrorCode =
  /** Outage: 5xx, timeout, network, unreadable reply. Never a denial. */
  | 'provider_unavailable'
  /** The provider's discovery document or this client's own key is unusable. */
  | 'provider_misconfigured'
  /** The provider answered and refused this client (400/401/403): revoked credential, suspended integration. */
  | 'provider_refused'
  /** The provider asked us to slow down (429). */
  | 'rate_limited'
  | 'state_mismatch'
  | 'invalid_token'
  | 'invalid_request'
  /** The token endpoint refused the code (routine: expired, reused, membership changed). */
  | 'sign_in_refused';

export class Workeasy360Error extends Error {
  constructor(
    readonly code: Workeasy360ErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'Workeasy360Error';
  }
}
