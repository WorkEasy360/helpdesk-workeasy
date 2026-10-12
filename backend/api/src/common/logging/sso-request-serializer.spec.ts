import { redactSsoCallback } from './sso-request-serializer';

describe('redactSsoCallback', () => {
  it('drops the code and state from the callback URL, and the parsed query', () => {
    const result = redactSsoCallback({
      method: 'GET',
      url: '/api/auth/callback/workeasy360?code=abc&state=def',
      query: { code: 'abc', state: 'def' },
    });
    expect(result.url).toBe('/api/auth/callback/workeasy360');
    expect(result).not.toHaveProperty('query');
    expect(JSON.stringify(result)).not.toContain('abc');
    expect(JSON.stringify(result)).not.toContain('def');
  });

  it('leaves every other request alone', () => {
    const request = { method: 'GET', url: '/api/v1/tickets?status=open', query: { status: 'open' } };
    expect(redactSsoCallback({ ...request })).toEqual(request);
    const start = { method: 'GET', url: '/api/auth/workeasy360/start?next=%2Ftickets', query: { next: '/tickets' } };
    expect(redactSsoCallback({ ...start })).toEqual(start);
  });
});
