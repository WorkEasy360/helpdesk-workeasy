import { redactSsoCallback, requestSerializer } from './sso-request-serializer';

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

  it("drops the start route's next too: it can carry the opened page's query (a search, a filter)", () => {
    const next = '/tickets?q=jane.doe%40example.com&status=open';
    const result = redactSsoCallback({
      method: 'GET',
      url: `/api/auth/workeasy360/start?next=${encodeURIComponent(next)}&organization=3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11`,
      query: { next, organization: '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11' },
    });
    expect(result.url).toBe('/api/auth/workeasy360/start');
    expect(result).not.toHaveProperty('query');
    expect(JSON.stringify(result)).not.toContain('jane.doe');
    expect(JSON.stringify(result)).not.toContain('tickets');
  });

  it('drops the query of every /api/auth request, whatever the route or letter case', () => {
    for (const url of [
      '/api/auth/workeasy360/logout?x=secret',
      '/api/auth/anything/else?x=secret',
      '/api/auth?x=secret',
      '/API/AUTH/workeasy360/start?next=%2Fsecret',
      '/api/auth/workeasy360/start?',
    ]) {
      const result = redactSsoCallback({ method: 'GET', url, query: { x: 'secret' } });
      expect(result.url).not.toContain('?');
      expect(result.url).not.toContain('secret');
      expect(result).not.toHaveProperty('query');
    }
  });

  it('leaves every other request alone', () => {
    for (const request of [
      { method: 'GET', url: '/api/v1/tickets?status=open', query: { status: 'open' } },
      { method: 'POST', url: '/api/v1/auth/login', query: {} },
      { method: 'GET', url: '/api/v1/auth/methods?x=1', query: { x: '1' } },
      // A longer first segment is not the auth base.
      { method: 'GET', url: '/api/authors?x=1', query: { x: '1' } },
      { method: 'GET', url: '/api/authz/start?x=1', query: { x: '1' } },
    ]) {
      expect(redactSsoCallback({ ...request })).toEqual(request);
    }
  });

  it('is what the request logger uses: the serialized request carries no query for the start route', () => {
    const serialized = requestSerializer({
      method: 'GET',
      url: '/api/auth/workeasy360/start?next=%2Ftickets%3Fq%3Dprivate',
      headers: { host: 'desk.example.com' },
      query: { next: '/tickets?q=private' },
      socket: { remoteAddress: '127.0.0.1', remotePort: 1234 },
    } as never);
    expect(JSON.stringify(serialized)).not.toContain('private');
    expect((serialized as { url?: string }).url).toBe('/api/auth/workeasy360/start');
  });
});
