import { createHash, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, exportJWK, jwtVerify, type JWK } from 'jose';
import { BACKCHANNEL_LOGOUT_EVENT, Workeasy360Client, pkcePair } from './client';
import { Workeasy360Error } from './errors';
import { fetchTransport, type Transport, type TransportResponse } from './transport';

const ISSUER = 'https://auth.example.test';
const CLIENT_ID = 'client-abc';
const REDIRECT = 'https://help.example.test/api/auth/callback/workeasy360';
const ORG = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const NONCE = 'nonce-123';
const STATE = 'state-123';

interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: JWK;
}

async function newSigner(kid: string, alg: 'RS256' | 'ES256' = 'RS256'): Promise<Signer> {
  const pair =
    alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = await exportJWK(pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg, use: 'sig' } };
}

class FakeProvider {
  calls: { method: string; url: string; form?: Record<string, string> | undefined }[] = [];
  keys: Signer[] = [];
  tokenResponse: () => TransportResponse = () => ({ status: 500, body: {} });
  entitlementResponse: () => TransportResponse = () => ({ status: 503, body: {} });
  discoveryOverride: Record<string, unknown> = {};
  /** The client assertions the token endpoint was sent. */
  assertions: string[] = [];
  clientKey: KeyObject | null = null;

  readonly transport: Transport = async (method, url, form) => {
    this.calls.push({ method, url, form });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        status: 200,
        body: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          end_session_endpoint: `${ISSUER}/logout`,
          workeasy360_entitlement_endpoint: `${ISSUER}/entitlements`,
          ...this.discoveryOverride,
        },
      };
    }
    if (url === `${ISSUER}/jwks`) {
      return { status: 200, body: { keys: this.keys.map((key) => key.jwk) } };
    }
    if (url === `${ISSUER}/token`) {
      this.assertions.push(form?.['client_assertion'] ?? '');
      return this.tokenResponse();
    }
    if (url === `${ISSUER}/entitlements`) {
      this.assertions.push(form?.['client_assertion'] ?? '');
      return this.entitlementResponse();
    }
    return { status: 404, body: {} };
  };

  count(url: string): number {
    return this.calls.filter((call) => call.url === url).length;
  }
}

interface ClaimOverrides {
  [key: string]: unknown;
}

async function mintIdToken(signer: Signer, overrides: ClaimOverrides = {}, alg: 'RS256' | 'ES256' = 'RS256') {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    sub: 'subject-1',
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    jti: 'jti-1',
    typ: 'id_token',
    nonce: NONCE,
    organization_id: ORG,
    product_code: 'easy_helpdesk',
    email: 'agent@example.test',
    email_verified: true,
    ...overrides,
  };
  for (const key of Object.keys(claims)) {
    if (claims[key] === undefined) delete claims[key];
  }
  return new SignJWT(claims).setProtectedHeader({ alg, kid: signer.kid }).sign(signer.privateKey);
}

async function setup(options: { clientAlg?: 'RS256' | 'ES256'; now?: () => number } = {}) {
  const provider = new FakeProvider();
  const signer = await newSigner('k1');
  provider.keys = [signer];
  const clientPair =
    options.clientAlg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  provider.clientKey = clientPair.publicKey;
  const client = new Workeasy360Client({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    keyId: 'client-key-1',
    privateKeyPem: clientPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    transport: provider.transport,
    ...(options.now ? { now: options.now } : {}),
  });
  return { provider, signer, client, clientPublicKey: clientPair.publicKey };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<Workeasy360Error> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code} but it resolved`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Workeasy360Error);
  expect((error as Workeasy360Error).code).toBe(code);
  return error as Workeasy360Error;
}

describe('Workeasy360Client discovery', () => {
  it('refuses a discovery document that names a different issuer', async () => {
    const { client, provider } = await setup();
    provider.discoveryOverride = { issuer: 'https://evil.example.test' };
    await expectCode(client.discover(), 'provider_misconfigured');
  });

  it('refuses an issuer that differs only by a trailing slash (exact comparison)', async () => {
    const { client, provider } = await setup();
    provider.discoveryOverride = { issuer: `${ISSUER}/` };
    await expectCode(client.discover(), 'provider_misconfigured');
  });

  it('refuses a document without a usable jwks_uri or with a non-http scheme', async () => {
    const { client, provider } = await setup();
    provider.discoveryOverride = { jwks_uri: 'javascript:alert(1)' };
    await expectCode(client.discover(), 'provider_misconfigured');
  });

  it('caches discovery for an hour, then refetches', async () => {
    let now = 1_000_000;
    const { client, provider } = await setup({ now: () => now });
    await client.discover();
    await client.discover();
    expect(provider.count(`${ISSUER}/.well-known/openid-configuration`)).toBe(1);
    now += 3600 * 1000 + 1;
    await client.discover();
    expect(provider.count(`${ISSUER}/.well-known/openid-configuration`)).toBe(2);
  });

  it('is an outage, not a denial, when discovery cannot be fetched', async () => {
    const provider = new FakeProvider();
    const client = new Workeasy360Client({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      keyId: 'k',
      privateKeyPem: 'unused',
      transport: async () => ({ status: 503, body: {} }),
    });
    expect(provider.calls).toHaveLength(0);
    await expectCode(client.discover(), 'provider_unavailable');
  });
});

describe('authorizationRequest', () => {
  it('builds a PKCE S256 request that forwards the organization and sends the configured redirect URI', async () => {
    const { client } = await setup();
    const request = await client.authorizationRequest({ organizationId: ORG });
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('openid email profile organization');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('organization')).toBe(ORG);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const expected = createHash('sha256').update(request.codeVerifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(request.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(request.state).not.toBe(request.nonce);
  });

  it('omits the organization when none was named, and generates fresh secrets each time', async () => {
    const { client } = await setup();
    const a = await client.authorizationRequest();
    const b = await client.authorizationRequest();
    expect(new URL(a.url).searchParams.has('organization')).toBe(false);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('pkcePair yields a verifier whose S256 hash is the challenge', () => {
    const { verifier, challenge } = pkcePair();
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
  });
});

describe('endSessionUrl', () => {
  it('points at the discovered end_session_endpoint with the client id and post-logout URI', async () => {
    const { client } = await setup();
    const url = new URL(await client.endSessionUrl('https://help.example.test/login'));
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/logout`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://help.example.test/login');
  });

  it('is empty when the provider advertises none', async () => {
    const { client, provider } = await setup();
    provider.discoveryOverride = { end_session_endpoint: undefined };
    expect(await client.endSessionUrl('https://help.example.test/login')).toBe('');
  });
});

describe('verifyIdToken', () => {
  it('accepts a good token and returns its claims', async () => {
    const { client, signer } = await setup();
    const claims = await client.verifyIdToken(await mintIdToken(signer), { nonce: NONCE });
    expect(claims.sub).toBe('subject-1');
    expect(claims.organization_id).toBe(ORG);
  });

  it('accepts an ES256 token from an EC key', async () => {
    const { client, provider } = await setup();
    const ec = await newSigner('ec1', 'ES256');
    provider.keys = [ec];
    const claims = await client.verifyIdToken(await mintIdToken(ec, {}, 'ES256'), { nonce: NONCE });
    expect(claims.sub).toBe('subject-1');
  });

  it.each([
    ['wrong audience', { aud: 'another-client' }],
    ['wrong issuer', { iss: 'https://evil.example.test' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 3900 }],
    ['wrong typ', { typ: 'access_token' }],
    ['missing typ', { typ: undefined }],
    ['missing jti', { jti: undefined }],
    ['missing sub', { sub: undefined }],
    ['missing exp', { exp: undefined }],
    ['missing iat', { iat: undefined }],
    ['wrong nonce', { nonce: 'someone-elses-nonce' }],
    ['missing nonce', { nonce: undefined }],
    ['missing organization_id', { organization_id: undefined }],
    ['issued in the future', { iat: Math.floor(Date.now() / 1000) + 3600, exp: Math.floor(Date.now() / 1000) + 4000 }],
  ])('refuses a token with %s', async (_name, overrides) => {
    const { client, signer } = await setup();
    await expectCode(client.verifyIdToken(await mintIdToken(signer, overrides), { nonce: NONCE }), 'invalid_token');
  });

  it('tolerates 30 seconds of clock skew on exp and nothing like 60', async () => {
    const { client, signer } = await setup();
    const now = Math.floor(Date.now() / 1000);
    await client.verifyIdToken(await mintIdToken(signer, { exp: now - 10, iat: now - 310 }), { nonce: NONCE });
    await expectCode(
      client.verifyIdToken(await mintIdToken(signer, { exp: now - 60, iat: now - 360 }), { nonce: NONCE }),
      'invalid_token',
    );
  });

  it('refuses alg none', async () => {
    const { client } = await setup();
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER, sub: 's', aud: CLIENT_ID, iat: now, exp: now + 300, jti: 'j', typ: 'id_token', nonce: NONCE, organization_id: ORG,
      }),
    ).toString('base64url');
    await expectCode(client.verifyIdToken(`${header}.${payload}.`, { nonce: NONCE }), 'invalid_token');
  });

  it('refuses an HS256 token signed with the provider public key as the secret (algorithm confusion)', async () => {
    const { client, signer } = await setup();
    const publicPem = createPublicKey(signer.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      iss: ISSUER, sub: 's', aud: CLIENT_ID, jti: 'j', typ: 'id_token', nonce: NONCE, organization_id: ORG,
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(Buffer.from(publicPem));
    await expectCode(client.verifyIdToken(forged, { nonce: NONCE }), 'invalid_token');
  });

  it('refuses a token signed by a key that is not in the provider key set', async () => {
    const { client } = await setup();
    const stranger = await newSigner('k1');
    await expectCode(client.verifyIdToken(await mintIdToken(stranger), { nonce: NONCE }), 'invalid_token');
  });

  it('refuses a token with no kid', async () => {
    const { client, signer } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: ISSUER, sub: 's', aud: CLIENT_ID, jti: 'j', typ: 'id_token', nonce: NONCE, organization_id: ORG,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signer.privateKey);
    await expectCode(client.verifyIdToken(token, { nonce: NONCE }), 'invalid_token');
  });

  it('refreshes the key set once for an unknown kid (rotation) and then accepts the token', async () => {
    let now = 5_000_000;
    const { client, provider } = await setup({ now: () => now });
    // Real time is used for token claims; the client's clock must agree.
    now = Date.now();
    await client.verifyIdToken(await mintIdToken(provider.keys[0]!), { nonce: NONCE });
    expect(provider.count(`${ISSUER}/jwks`)).toBe(1);

    const rotated = await newSigner('k2');
    provider.keys = [provider.keys[0]!, rotated];
    now += 11_000; // past the refresh cooldown
    const claims = await client.verifyIdToken(await mintIdToken(rotated), { nonce: NONCE });
    expect(claims.sub).toBe('subject-1');
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);
  });

  it('refreshes at most once per token for an unknown kid, then fails', async () => {
    let now = Date.now();
    const { client, provider } = await setup({ now: () => now });
    await client.verifyIdToken(await mintIdToken(provider.keys[0]!), { nonce: NONCE });
    now += 11_000;
    const stranger = await newSigner('nope');
    await expectCode(client.verifyIdToken(await mintIdToken(stranger), { nonce: NONCE }), 'invalid_token');
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);
  });

  it('does not let garbage tokens hammer the provider: refresh is rate limited by a cooldown', async () => {
    const now = Date.now();
    const { client, provider } = await setup({ now: () => now });
    const stranger = await newSigner('nope');
    for (let i = 0; i < 5; i += 1) {
      await expectCode(client.verifyIdToken(await mintIdToken(stranger), { nonce: NONCE }), 'invalid_token');
    }
    expect(provider.count(`${ISSUER}/jwks`)).toBe(1);
  });
});

describe('complete (the token exchange)', () => {
  it('sends the code, the verifier, the same redirect URI and a private_key_jwt assertion, then returns verified claims', async () => {
    const { client, provider, signer, clientPublicKey } = await setup();
    provider.tokenResponse = () => ({ status: 200, body: { id_token: 'placeholder' } });
    const idToken = await mintIdToken(signer);
    provider.tokenResponse = () => ({ status: 200, body: { id_token: idToken } });

    const claims = await client.complete({
      code: 'code-1',
      returnedState: STATE,
      expectedState: STATE,
      nonce: NONCE,
      codeVerifier: 'verifier-1',
    });
    expect(claims.organization_id).toBe(ORG);

    const call = provider.calls.find((c) => c.url === `${ISSUER}/token`)!;
    expect(call.method).toBe('POST');
    expect(call.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      code_verifier: 'verifier-1',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    const { payload, protectedHeader } = await jwtVerify(call.form!['client_assertion']!, clientPublicKey, {
      issuer: CLIENT_ID,
      audience: `${ISSUER}/token`,
    });
    expect(payload.sub).toBe(CLIENT_ID);
    expect(typeof payload.jti).toBe('string');
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    expect(protectedHeader.kid).toBe('client-key-1');
    expect(protectedHeader.alg).toBe('RS256');
  });

  it('signs the client assertion with ES256 for a P-256 key', async () => {
    const { client, clientPublicKey } = await setup({ clientAlg: 'ES256' });
    const assertion = await client.clientAssertion();
    const { protectedHeader } = await jwtVerify(assertion, clientPublicKey, { issuer: CLIENT_ID });
    expect(protectedHeader.alg).toBe('ES256');
  });

  it('refuses a key that is neither RSA nor P-256', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const provider = new FakeProvider();
    const client = new Workeasy360Client({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      keyId: 'k',
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      transport: provider.transport,
    });
    await expectCode(client.clientAssertion(), 'provider_misconfigured');
  });

  it('refuses a mismatched state before talking to the provider', async () => {
    const { client, provider } = await setup();
    await expectCode(
      client.complete({ code: 'c', returnedState: 'other', expectedState: STATE, nonce: NONCE, codeVerifier: 'v' }),
      'state_mismatch',
    );
    expect(provider.count(`${ISSUER}/token`)).toBe(0);
  });

  it('refuses an empty expected state', async () => {
    const { client } = await setup();
    await expectCode(
      client.complete({ code: 'c', returnedState: '', expectedState: '', nonce: NONCE, codeVerifier: 'v' }),
      'state_mismatch',
    );
  });

  it.each([
    [400, { error: 'invalid_grant' }, 'sign_in_refused'],
    [401, { error: 'invalid_client' }, 'sign_in_refused'],
    [429, {}, 'rate_limited'],
    [503, {}, 'provider_unavailable'],
    [400, { error: 'temporarily_unavailable' }, 'provider_unavailable'],
  ])('maps a %s token response to %s', async (status, body, code) => {
    const { client, provider } = await setup();
    provider.tokenResponse = () => ({ status, body });
    await expectCode(
      client.complete({ code: 'c', returnedState: STATE, expectedState: STATE, nonce: NONCE, codeVerifier: 'v' }),
      code,
    );
  });

  it('refuses a token response without an id_token', async () => {
    const { client, provider } = await setup();
    provider.tokenResponse = () => ({ status: 200, body: { access_token: 'x' } });
    await expectCode(
      client.complete({ code: 'c', returnedState: STATE, expectedState: STATE, nonce: NONCE, codeVerifier: 'v' }),
      'invalid_token',
    );
  });
});

describe('verifyEntitlement', () => {
  const allow = { decision: 'allow', reason: 'entitled', write_allowed: true, revalidate_after: 600 };

  it('posts the organization, the subject and a client assertion to the discovered endpoint', async () => {
    const { client, provider } = await setup();
    provider.entitlementResponse = () => ({ status: 200, body: allow });
    const answer = await client.verifyEntitlement(ORG, { subject: 'subject-1' });
    expect(answer).toEqual({ decision: 'allow', reason: 'entitled', writeAllowed: true, revalidateAfter: 600 });
    const call = provider.calls.find((c) => c.url === `${ISSUER}/entitlements`)!;
    expect(call.form).toMatchObject({ organization_id: ORG, subject: 'subject-1', write: 'false' });
    expect(call.form!['client_assertion']).toBeTruthy();
  });

  it('omits the subject for background work', async () => {
    const { client, provider } = await setup();
    provider.entitlementResponse = () => ({ status: 200, body: allow });
    await client.verifyEntitlement(ORG);
    const call = provider.calls.find((c) => c.url === `${ISSUER}/entitlements`)!;
    expect(call.form).not.toHaveProperty('subject');
  });

  it('reports a denial with its reason and never write_allowed', async () => {
    const { client, provider } = await setup();
    provider.entitlementResponse = () => ({
      status: 200,
      body: { decision: 'deny', reason: 'membership_inactive', write_allowed: true },
    });
    expect(await client.verifyEntitlement(ORG, { subject: 's' })).toMatchObject({
      decision: 'deny',
      reason: 'membership_inactive',
      writeAllowed: false,
    });
  });

  it.each([
    [400, 'provider_refused'],
    [401, 'provider_refused'],
    [403, 'provider_refused'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('maps HTTP %s to %s', async (status, code) => {
    const { client, provider } = await setup();
    provider.entitlementResponse = () => ({ status, body: { error: 'x' } });
    await expectCode(client.verifyEntitlement(ORG), code);
  });

  it('is a misconfiguration when discovery names no entitlement endpoint', async () => {
    const { client, provider } = await setup();
    provider.discoveryOverride = { workeasy360_entitlement_endpoint: undefined };
    await expectCode(client.verifyEntitlement(ORG), 'provider_misconfigured');
  });

  it('treats an unreadable 200 body as an outage, never as an answer', async () => {
    const { client, provider } = await setup();
    provider.entitlementResponse = () => ({ status: 200, body: {} });
    await expectCode(client.verifyEntitlement(ORG), 'provider_unavailable');
  });
});

describe('fetchTransport', () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('parses JSON replies and posts forms as urlencoded', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport = fetchTransport({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    const reply = await transport('POST', 'https://x.example.test/a', { a: '1', b: 'two words' });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(seen[0]!.init.body).toBe('a=1&b=two+words');
    expect((seen[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(seen[0]!.init.redirect).toBe('error');
  });

  it('refuses non-http URLs', async () => {
    const transport = fetchTransport({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    await expectCode(transport('GET', 'file:///etc/passwd'), 'provider_unavailable');
    await expectCode(transport('GET', 'javascript:alert(1)'), 'provider_unavailable');
    await expectCode(transport('GET', 'not a url'), 'provider_unavailable');
  });

  it('turns network failures, timeouts and oversized bodies into an outage', async () => {
    const failing = fetchTransport({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expectCode(failing('GET', 'https://x.example.test/'), 'provider_unavailable');

    const huge = fetchTransport({
      fetchImpl: (async () => new Response('x'.repeat(2 * 1024 * 1024))) as unknown as typeof fetch,
    });
    await expectCode(huge('GET', 'https://x.example.test/'), 'provider_unavailable');
  });

  it('passes an abort signal so every call is bounded by a timeout', async () => {
    let signal: AbortSignal | undefined;
    const transport = fetchTransport({
      timeoutMs: 50,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    await transport('GET', 'https://x.example.test/');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('returns an empty body for non-JSON replies', async () => {
    const transport = fetchTransport({
      fetchImpl: (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch,
    });
    expect(await transport('GET', 'https://x.example.test/')).toEqual({ status: 502, body: {} });
  });
});

describe('audience and endpoint strictness', () => {
  it('accepts an audience that is exactly this client, as a string or a one-element list', async () => {
    const { client, signer } = await setup();
    await client.verifyIdToken(await mintIdToken(signer, { aud: [CLIENT_ID] }), { nonce: NONCE });
  });

  it('refuses an audience that also names another client (multi-valued aud)', async () => {
    const { client, signer } = await setup();
    await expectCode(
      client.verifyIdToken(await mintIdToken(signer, { aud: [CLIENT_ID, 'another-client'] }), { nonce: NONCE }),
      'invalid_token',
    );
  });

  it('refuses an authorized party that is another client, and accepts our own', async () => {
    const { client, signer } = await setup();
    await expectCode(
      client.verifyIdToken(await mintIdToken(signer, { azp: 'another-client' }), { nonce: NONCE }),
      'invalid_token',
    );
    await client.verifyIdToken(await mintIdToken(signer, { azp: CLIENT_ID }), { nonce: NONCE });
  });

  it('refuses a discovery document with a non-https endpoint when https is required', async () => {
    const provider = new FakeProvider();
    const strict = new Workeasy360Client({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      keyId: 'k',
      privateKeyPem: 'unused',
      transport: provider.transport,
      requireHttps: true,
    });
    await expect(strict.discover()).resolves.toBeDefined(); // the fake serves https endpoints
    for (const key of ['token_endpoint', 'jwks_uri', 'authorization_endpoint', 'end_session_endpoint', 'workeasy360_entitlement_endpoint']) {
      const fresh = new FakeProvider();
      fresh.discoveryOverride = { [key]: 'http://auth.example.test/x' };
      const client = new Workeasy360Client({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        keyId: 'k',
        privateKeyPem: 'unused',
        transport: fresh.transport,
        requireHttps: true,
      });
      await expectCode(client.discover(), 'provider_misconfigured');
    }
    // Without the requirement (development) http is fine.
    const lax = new FakeProvider();
    lax.discoveryOverride = { token_endpoint: 'http://auth.example.test/token' };
    await new Workeasy360Client({
      issuer: ISSUER, clientId: CLIENT_ID, keyId: 'k', privateKeyPem: 'unused', transport: lax.transport,
    }).discover();
  });
});

describe('verifyLogoutToken (OpenID Connect Back-Channel Logout 1.0)', () => {
  let rsa: Signer;
  let ec: Signer;

  beforeAll(async () => {
    rsa = await newSigner('logout-rsa');
    ec = await newSigner('logout-ec', 'ES256');
  });

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  /** A client that only verifies (no client key needed), against a provider publishing `keys`. */
  function verifier(keys: Signer[] = [rsa], now?: () => number) {
    const provider = new FakeProvider();
    provider.keys = keys;
    const client = new Workeasy360Client({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      keyId: 'unused',
      privateKeyPem: 'unused',
      transport: provider.transport,
      ...(now ? { now } : {}),
    });
    return { provider, client };
  }

  interface LogoutOptions {
    /** The JOSE typ header; null leaves it out. */
    typ?: string | null;
    alg?: 'RS256' | 'ES256' | 'RS384';
  }

  /** As Workeasy360 mints one: typ logout+jwt; iss, aud, iat, exp (120 s), jti, typ claim, events, sub, sid. */
  async function mintLogoutToken(signer: Signer, overrides: ClaimOverrides = {}, options: LogoutOptions = {}) {
    const now = nowSeconds();
    const claims: Record<string, unknown> = {
      iss: ISSUER,
      sub: 'subject-1',
      aud: CLIENT_ID,
      iat: now,
      exp: now + 120,
      jti: randomUUID().replace(/-/g, ''),
      typ: 'logout_token',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      sid: 'sign-in-1',
      ...overrides,
    };
    for (const key of Object.keys(claims)) {
      if (claims[key] === undefined) delete claims[key];
    }
    const typ = options.typ === undefined ? 'logout+jwt' : options.typ;
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: options.alg ?? (signer.jwk.kty === 'EC' ? 'ES256' : 'RS256'),
        kid: signer.kid,
        ...(typ === null ? {} : { typ }),
      })
      .sign(signer.privateKey);
  }

  it('accepts a token naming a sign-in and returns what it names', async () => {
    const { client } = verifier();
    const now = nowSeconds();
    const token = await mintLogoutToken(rsa, { jti: 'jti-a', iat: now, exp: now + 120 });
    await expect(client.verifyLogoutToken(token)).resolves.toEqual({
      jti: 'jti-a',
      sub: 'subject-1',
      sid: 'sign-in-1',
      // exp plus the 30 s skew (and a second): after that the token is refused anyway.
      acceptableUntil: now + 120 + 31,
    });
  });

  it('accepts a token with only sub ("sign out everywhere") and one with only sid', async () => {
    const { client } = verifier();
    const everywhere = await client.verifyLogoutToken(await mintLogoutToken(rsa, { sid: undefined }));
    expect(everywhere.sub).toBe('subject-1');
    expect(everywhere).not.toHaveProperty('sid');
    const one = await client.verifyLogoutToken(await mintLogoutToken(rsa, { sub: undefined }));
    expect(one.sid).toBe('sign-in-1');
    expect(one).not.toHaveProperty('sub');
  });

  it('accepts an ES256 key, the typ header application/logout+jwt, and a token without the typ claim', async () => {
    const { client } = verifier([rsa, ec]);
    await client.verifyLogoutToken(await mintLogoutToken(ec));
    await client.verifyLogoutToken(await mintLogoutToken(rsa, {}, { typ: 'application/logout+jwt' }));
    await client.verifyLogoutToken(await mintLogoutToken(rsa, { typ: undefined }));
  });

  it('accepts an audience list that contains this client (with azp when there are several)', async () => {
    const { client } = verifier();
    await client.verifyLogoutToken(await mintLogoutToken(rsa, { aud: [CLIENT_ID] }));
    await client.verifyLogoutToken(await mintLogoutToken(rsa, { aud: [CLIENT_ID, 'another-client'], azp: CLIENT_ID }));
  });

  const CLAIM = /ERR_JWT_CLAIM_VALIDATION_FAILED/;
  it.each<[string, ClaimOverrides, RegExp]>([
    ['another issuer', { iss: 'https://evil.example.test' }, CLAIM],
    ['the issuer with a trailing slash (exact comparison)', { iss: `${ISSUER}/` }, CLAIM],
    ['another audience', { aud: 'another-client' }, CLAIM],
    ['several audiences and no azp', { aud: [CLIENT_ID, 'another-client'] }, /several audiences/],
    ['an azp that is another client', { azp: 'another-client' }, /azp is another client/],
    ['no aud', { aud: undefined }, CLAIM],
    ['an exp that has passed', { iat: nowSeconds() - 300, exp: nowSeconds() - 120 }, /ERR_JWT_EXPIRED/],
    ['no exp', { exp: undefined }, CLAIM],
    ['no iat', { iat: undefined }, CLAIM],
    ['an iat in the future', { iat: nowSeconds() + 300, exp: nowSeconds() + 420 }, /iat is in the future/],
    ['an iat older than ten minutes, even with exp ahead', { iat: nowSeconds() - 3600, exp: nowSeconds() + 60 }, /too old/],
    ['no events', { events: undefined }, CLAIM],
    ['events that are not an object', { events: [BACKCHANNEL_LOGOUT_EVENT] }, /back-channel logout event/],
    ['events without the back-channel logout event', { events: { 'http://example.test/other': {} } }, /back-channel logout event/],
    ['the event not as an object', { events: { [BACKCHANNEL_LOGOUT_EVENT]: true } }, /back-channel logout event/],
    ['the event as null', { events: { [BACKCHANNEL_LOGOUT_EVENT]: null } }, /back-channel logout event/],
    ['a nonce', { nonce: 'n' }, /must not carry a nonce/],
    ['the typ claim of an ID token', { typ: 'id_token' }, /typ is not logout_token/],
    ['the typ claim of an access token', { typ: 'access_token' }, /typ is not logout_token/],
    ['neither sub nor sid', { sub: undefined, sid: undefined }, /neither sub nor sid/],
    ['an empty sub and no sid', { sub: '', sid: undefined }, /sub is not a usable identifier/],
    ['a sid that is not a string', { sid: 42 }, /sid is not a usable identifier/],
    ['a sub longer than 255 characters', { sub: 'x'.repeat(256) }, /sub is not a usable identifier/],
    ['no jti', { jti: undefined }, CLAIM],
    ['an empty jti', { jti: '' }, /jti is not a usable identifier/],
  ])('refuses a token with %s', async (_name, overrides, reason) => {
    const { client } = verifier();
    const error = await expectCode(client.verifyLogoutToken(await mintLogoutToken(rsa, overrides)), 'invalid_token');
    expect(error.detail).toMatch(reason);
  });

  it('tolerates 30 seconds of clock skew on exp and nothing like 60', async () => {
    const { client } = verifier();
    const t = nowSeconds();
    await client.verifyLogoutToken(await mintLogoutToken(rsa, { iat: t - 130, exp: t - 10 }));
    await expectCode(client.verifyLogoutToken(await mintLogoutToken(rsa, { iat: t - 180, exp: t - 60 })), 'invalid_token');
  });

  it.each<[string, LogoutOptions]>([
    ['no typ header', { typ: null }],
    ['the typ header JWT', { typ: 'JWT' }],
    ['the typ header of an access token', { typ: 'at+jwt' }],
  ])('refuses a token with %s', async (_name, options) => {
    const { client } = verifier();
    await expectCode(client.verifyLogoutToken(await mintLogoutToken(rsa, {}, options)), 'invalid_token');
  });

  it('refuses an ID token presented as a logout token', async () => {
    const { client } = verifier();
    await expectCode(client.verifyLogoutToken(await mintIdToken(rsa)), 'invalid_token');
  });

  it('refuses a token signed by a key that is not the published one, or altered after signing', async () => {
    const { client } = verifier();
    const impostor = await newSigner(rsa.kid);
    const error = await expectCode(client.verifyLogoutToken(await mintLogoutToken(impostor)), 'invalid_token');
    expect(error.detail).toMatch(/ERR_JWS_SIGNATURE_VERIFICATION_FAILED/);

    const [header, , signature] = (await mintLogoutToken(rsa)).split('.');
    const altered = Buffer.from(
      JSON.stringify({
        iss: ISSUER, sub: 'someone-else', aud: CLIENT_ID, iat: nowSeconds(), exp: nowSeconds() + 120, jti: 'j',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      }),
    ).toString('base64url');
    await expectCode(client.verifyLogoutToken(`${header}.${altered}.${signature}`), 'invalid_token');
  });

  it('refuses alg none and an HS256 token keyed with the public key (algorithm confusion)', async () => {
    const { client } = verifier();
    const claims = {
      iss: ISSUER, sub: 's', aud: CLIENT_ID, iat: nowSeconds(), exp: nowSeconds() + 120, jti: 'j',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${encode({ alg: 'none', kid: rsa.kid, typ: 'logout+jwt' })}.${encode(claims)}.`;
    await expectCode(client.verifyLogoutToken(none), 'invalid_token');

    const publicPem = createPublicKey(rsa.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: rsa.kid, typ: 'logout+jwt' })
      .sign(Buffer.from(publicPem));
    await expectCode(client.verifyLogoutToken(forged), 'invalid_token');
  });

  it('takes the algorithm from the key set entry, not from the token', async () => {
    // The RSA key is published as RS256: a token that asks for RS384 with it is refused.
    const { client } = verifier();
    await expectCode(client.verifyLogoutToken(await mintLogoutToken(rsa, {}, { alg: 'RS384' })), 'invalid_token');

    // An entry without alg: the key type decides (RSA, so RS256).
    const bare: Signer = { ...rsa, jwk: { ...rsa.jwk, alg: undefined } };
    await verifier([bare]).client.verifyLogoutToken(await mintLogoutToken(rsa));

    // An entry whose alg or use contradicts the key, or is not one we accept, is not used.
    for (const jwk of [{ ...rsa.jwk, alg: 'ES256' }, { ...rsa.jwk, alg: 'PS256' }, { ...rsa.jwk, use: 'enc' }]) {
      const odd: Signer = { ...rsa, jwk };
      const error = await expectCode(verifier([odd]).client.verifyLogoutToken(await mintLogoutToken(rsa)), 'invalid_token');
      expect(error.detail).toMatch(/not an RS256 or ES256 signing key/);
    }

    // An EC key published as ES256 with a token whose header claims RS256 is refused by the key's algorithm.
    const mismatch = await new SignJWT({
      iss: ISSUER, sub: 's', aud: CLIENT_ID, iat: nowSeconds(), exp: nowSeconds() + 120, jti: 'j',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    })
      .setProtectedHeader({ alg: 'RS256', kid: ec.kid, typ: 'logout+jwt' })
      .sign(rsa.privateKey);
    const error = await expectCode(verifier([ec]).client.verifyLogoutToken(mismatch), 'invalid_token');
    expect(error.detail).toMatch(/says RS256 but key logout-ec is ES256/);
  });

  it('refuses a token with no kid', async () => {
    const { client } = verifier();
    const token = await new SignJWT({
      iss: ISSUER, sub: 's', aud: CLIENT_ID, iat: nowSeconds(), exp: nowSeconds() + 120, jti: 'j',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'logout+jwt' })
      .sign(rsa.privateKey);
    await expectCode(client.verifyLogoutToken(token), 'invalid_token');
  });

  it('refreshes the key set exactly once for an unknown kid (rotation), then accepts the token', async () => {
    let clock = Date.now();
    const { client, provider } = verifier([rsa], () => clock);
    await client.verifyLogoutToken(await mintLogoutToken(rsa));
    expect(provider.count(`${ISSUER}/jwks`)).toBe(1);

    const rotated = await newSigner('logout-rotated');
    provider.keys = [rsa, rotated];
    clock += 11_000; // past the refresh cooldown
    const t = Math.floor(clock / 1000);
    await client.verifyLogoutToken(await mintLogoutToken(rotated, { iat: t, exp: t + 120 }));
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);
    // The refreshed set is reused: the next token with that kid fetches nothing.
    await client.verifyLogoutToken(await mintLogoutToken(rotated, { iat: t, exp: t + 120 }));
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);
  });

  it('refreshes once for a kid that stays unknown, then refuses; within the cooldown it does not refresh again', async () => {
    let clock = Date.now();
    const { client, provider } = verifier([rsa], () => clock);
    await client.verifyLogoutToken(await mintLogoutToken(rsa));
    const stranger = await newSigner('logout-unknown');

    clock += 11_000;
    const t = Math.floor(clock / 1000);
    await expectCode(client.verifyLogoutToken(await mintLogoutToken(stranger, { iat: t, exp: t + 120 })), 'invalid_token');
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);

    for (let i = 0; i < 3; i += 1) {
      await expectCode(client.verifyLogoutToken(await mintLogoutToken(stranger, { iat: t, exp: t + 120 })), 'invalid_token');
    }
    expect(provider.count(`${ISSUER}/jwks`)).toBe(2);
  });

  it('is an outage, not a refusal, when the key set cannot be read (so the provider retries)', async () => {
    const { client, provider } = verifier();
    const token = await mintLogoutToken(rsa);
    const down = new Workeasy360Client({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      keyId: 'unused',
      privateKeyPem: 'unused',
      transport: async (method, url, form) =>
        url === `${ISSUER}/jwks` ? { status: 503, body: {} } : provider.transport(method, url, form),
    });
    await expectCode(down.verifyLogoutToken(token), 'provider_unavailable');
    await client.verifyLogoutToken(token);
  });

  it('refuses a malformed token before fetching anything', async () => {
    const { client, provider } = verifier();
    for (const garbage of ['', 'abc', 'a.b', 'a.b.c.d', '!!!.e30.']) {
      await expectCode(client.verifyLogoutToken(garbage), 'invalid_token');
    }
    expect(provider.calls).toHaveLength(0);
  });
});
