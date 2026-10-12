import { WORKEASY360_SSO_ERROR_CODES } from '@digisoft/shared';
import { Workeasy360Error, type Workeasy360ErrorCode } from '@digisoft/workeasy360';
import { PROVIDER_ERRORS, codeForClientError, codeForProviderError, isSsoErrorCode } from './sso-errors';

describe('SSO error vocabulary', () => {
  it('maps every provider error into the fixed vocabulary', () => {
    for (const [providerError, code] of Object.entries(PROVIDER_ERRORS)) {
      expect(WORKEASY360_SSO_ERROR_CODES).toContain(code);
      expect(codeForProviderError(providerError)).toBe(code);
    }
  });

  it.each([
    ['access_denied', 'cancelled'],
    ['login_required', 'expired'],
    ['interaction_required', 'expired'],
    ['product_not_entitled', 'not_entitled'],
    ['product_no_seat', 'no_seat'],
    ['membership_inactive', 'provider_membership_inactive'],
    ['organization_inactive', 'organization_inactive'],
    ['access_policy_denied', 'access_policy'],
    ['unauthorized_client', 'unavailable'],
    ['server_error', 'unavailable'],
    ['temporarily_unavailable', 'unavailable'],
  ])('maps %s to %s', (providerError, code) => {
    expect(codeForProviderError(providerError)).toBe(code);
  });

  it('treats anything unknown, including prototype keys, as refused', () => {
    expect(codeForProviderError('something_new')).toBe('refused');
    expect(codeForProviderError('constructor')).toBe('refused');
    expect(codeForProviderError('__proto__')).toBe('refused');
    expect(codeForProviderError('')).toBe('refused');
  });

  it('maps every protocol client error into the vocabulary', () => {
    const codes: Workeasy360ErrorCode[] = [
      'provider_unavailable',
      'provider_misconfigured',
      'provider_refused',
      'rate_limited',
      'state_mismatch',
      'invalid_token',
      'invalid_request',
      'sign_in_refused',
    ];
    for (const code of codes) {
      expect(WORKEASY360_SSO_ERROR_CODES).toContain(codeForClientError(new Workeasy360Error(code)));
    }
    expect(codeForClientError(new Workeasy360Error('state_mismatch'))).toBe('expired');
    expect(codeForClientError(new Workeasy360Error('rate_limited'))).toBe('rate_limited');
    expect(codeForClientError(new Workeasy360Error('provider_unavailable'))).toBe('unavailable');
    expect(codeForClientError(new Workeasy360Error('invalid_token'))).toBe('refused');
    expect(codeForClientError(new Workeasy360Error('sign_in_refused'))).toBe('refused');
  });

  it('recognises exactly the vocabulary', () => {
    expect(WORKEASY360_SSO_ERROR_CODES).toHaveLength(17);
    for (const code of WORKEASY360_SSO_ERROR_CODES) expect(isSsoErrorCode(code)).toBe(true);
    expect(isSsoErrorCode('anything_else')).toBe(false);
  });
});
