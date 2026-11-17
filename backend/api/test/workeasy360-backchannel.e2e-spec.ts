import request from 'supertest';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { Harness } from './app.harness';
import { FakeWorkeasy360, type Identity, type LogoutTokenTweaks } from './support/fake-workeasy360';

/**
 * OpenID Connect Back-Channel Logout 1.0, the receiver, end to end: the real application against
 * real Postgres and Redis, and a fake Workeasy360 in this process that signs people in (with the
 * `sid` a product with a back-channel URI receives) and mints logout tokens the way the platform
 * does (ADR-069). The test plays both the browsers and the platform's delivery worker, which
 * sends no cookie and no CSRF token.
 *
 * The environment is set before the application module is first loaded, hence the dynamic imports.
 */

const FRONTEND = 'http://localhost:3000';
const REDIRECT_URI = `${FRONTEND}/api/auth/callback/workeasy360`;
const START = '/api/auth/workeasy360/start';
const CALLBACK = '/api/auth/callback/workeasy360';
const BACKCHANNEL = '/api/auth/workeasy360/backchannel-logout';
const REFRESH = '/api/v1/auth/refresh';
const FLOW_COOKIE = 'ds_w360_flow';
const REFRESH_COOKIE = 'ds_refresh';
const EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const ORG_A = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const ORG_B = '9a8c7d6e-5f4e-4d3c-8b2a-1a0b9c8d7e6f';

const ada: Identity = {
  sub: 'sub-ada',
  email: 'ada@acme.example',
  emailVerified: true,
  name: 'Ada Agent',
  organizationId: ORG_A,
  organizationName: 'Acme Support',
};
/** The same Workeasy360 person in a second organization: a second Help Desk user. */
const adaAtGlobex: Identity = {
  ...ada,
  email: 'ada@globex.example',
  organizationId: ORG_B,
  organizationName: 'Globex',
};
const ben: Identity = {
  sub: 'sub-ben',
  email: 'ben@acme.example',
  emailVerified: true,
  name: 'Ben Bystander',
  organizationId: ORG_A,
};

/** The key-set refresh cooldown of the client (JWKS_REFRESH_COOLDOWN_SECONDS), plus a margin. */
const PAST_COOLDOWN_MS = 10_500;

interface BrowserSession {
  cookie: string;
  familyId: string;
}

describe('Back-channel logout from Workeasy360 (e2e)', () => {
  let provider: FakeWorkeasy360;
  let harness: Harness;
  let http: Server;
  let helpers: typeof import('./app.harness');
  let hashRefreshToken: (raw: string) => string;
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  // --- helpers ------------------------------------------------------------------

  const pair = (response: request.Response, name: string): string | undefined =>
    ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(';')[0];

  /** A browser signing in through Workeasy360: start, sign in at the provider, callback. */
  async function signIn(identity: Identity, sid?: string): Promise<BrowserSession> {
    const started = await request(http).get(START).expect(302);
    const flow = pair(started, FLOW_COOKIE)!;
    const authorization = provider.authorize(
      started.headers['location'] as string,
      identity,
      sid ? { sid } : {},
    );
    if (!authorization.ok) throw new Error(`the provider refused (${authorization.error})`);
    const callback = await request(http)
      .get(`${CALLBACK}${new URL(authorization.callbackUrl).search}`)
      .set('Cookie', flow)
      .expect(302);
    expect(callback.headers['location']).toBe(`${FRONTEND}/dashboard`);
    const cookie = pair(callback, REFRESH_COOKIE)!;
    const stored = await harness.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie.split('=')[1]!) },
      select: { familyId: true },
    });
    return { cookie, familyId: stored.familyId };
  }

  /** The platform's delivery: a form POST, no cookie, no CSRF token. */
  const deliver = (token: string) =>
    request(http).post(BACKCHANNEL).type('form').send({ logout_token: token });

  /** Unrevoked refresh tokens of a session (refresh-token family). */
  const live = (session: BrowserSession): Promise<number> =>
    harness.prisma.refreshToken.count({ where: { familyId: session.familyId, revokedAt: null } });

  /** What the browser finds when it next renews its session. */
  const refreshStatus = async (session: BrowserSession): Promise<number> =>
    (await request(http).post(REFRESH).set('Cookie', session.cookie)).status;

  const acceptedJtis = (): Promise<number> => harness.prisma.workeasy360LogoutToken.count();

  const expectRefused = (response: request.Response): void => {
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(response.headers['cache-control']).toBe('no-store');
  };

  // --- lifecycle -----------------------------------------------------------------

  beforeAll(async () => {
    provider = await FakeWorkeasy360.start({
      redirectUri: REDIRECT_URI,
      appPublicKey: appKeys.publicKey,
    });
    Object.assign(process.env, {
      WORKEASY360_ISSUER: provider.issuer,
      WORKEASY360_CLIENT_ID: provider.clientId,
      WORKEASY360_REDIRECT_URI: REDIRECT_URI,
      WORKEASY360_KEY_ID: provider.keyId,
      WORKEASY360_PRIVATE_KEY: appKeys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      // As in production: Workeasy360 is the only way in.
      WORKEASY360_SSO_ONLY: 'true',
    });
    helpers = await import('./app.harness');
    harness = await helpers.createHarness();
    http = harness.app.getHttpServer() as Server;
    const { TokenService } = await import('../src/auth/token.service');
    const tokens = harness.app.get(TokenService);
    hashRefreshToken = (raw) => tokens.hashRefreshToken(raw);
  }, 240_000);

  beforeEach(async () => {
    await helpers.resetDatabase(harness.prisma, harness.redis);
    provider.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await harness?.close();
    await provider?.stop();
  });

  // --- recording sign-ins ----------------------------------------------------------

  describe('at sign-in', () => {
    it('records the session the sign-in opened, the person (issuer, sub) and the ID token sid', async () => {
      const session = await signIn(ada, 'w360-sign-in-1');
      const records = await harness.prisma.workeasy360SignIn.findMany();
      expect(records).toHaveLength(1);
      const user = await harness.prisma.user.findFirstOrThrow({ where: { email: ada.email } });
      expect(records[0]).toMatchObject({
        familyId: session.familyId,
        userId: user.id,
        organizationId: user.organizationId,
        issuer: provider.issuer,
        subject: ada.sub,
        providerSid: 'w360-sign-in-1',
        endedAt: null,
      });
    });

    it('records a sign-in without sid (no back-channel URI registered) with no sid', async () => {
      await signIn(ada);
      const record = await harness.prisma.workeasy360SignIn.findFirstOrThrow();
      expect(record.providerSid).toBeNull();
      expect(record.subject).toBe(ada.sub);
    });

    it('keeps the record pointing at the session across refresh-token rotation', async () => {
      const session = await signIn(ada, 'w360-rotating');
      const renewed = await request(http).post(REFRESH).set('Cookie', session.cookie).expect(200);
      const next = pair(renewed, REFRESH_COOKIE)!;
      const rotated = await harness.prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashRefreshToken(next.split('=')[1]!) },
      });
      expect(rotated.familyId).toBe(session.familyId);

      expect(
        (await deliver(await provider.logoutToken({ sub: ada.sub, sid: 'w360-rotating' }))).status,
      ).toBe(200);
      expect(await refreshStatus({ cookie: next, familyId: session.familyId })).toBe(401);
    });
  });

  // --- the endpoint --------------------------------------------------------------------

  describe('POST /api/auth/workeasy360/backchannel-logout', () => {
    it('ends only the sessions of the sign-in a sid names', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const phone = await signIn(ada, 'w360-phone'); // the same person, another Workeasy360 sign-in
      const bystander = await signIn(ben, 'w360-ben');

      const response = await deliver(
        await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }),
      );
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toBe('');

      expect(await live(laptop)).toBe(0);
      expect(await live(phone)).toBe(1);
      expect(await live(bystander)).toBe(1);
      const ended = await harness.prisma.workeasy360SignIn.findUniqueOrThrow({
        where: { familyId: laptop.familyId },
      });
      expect(ended.endedAt).toBeInstanceOf(Date);

      // What each browser finds at its next renewal.
      expect(await refreshStatus(laptop)).toBe(401);
      expect(await refreshStatus(phone)).toBe(200);
      expect(await refreshStatus(bystander)).toBe(200);
    });

    it('ends every session of the person, in every organization, when the token names only sub', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const phone = await signIn(ada, 'w360-phone');
      const globex = await signIn(adaAtGlobex, 'w360-globex');
      const beforeSid = await signIn(ada); // opened before a back-channel URI was registered: no sid
      const bystander = await signIn(ben, 'w360-ben');

      const response = await deliver(await provider.logoutToken({ sub: ada.sub }));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');

      for (const session of [laptop, phone, globex, beforeSid]) {
        expect(await live(session)).toBe(0);
      }
      expect(await live(bystander)).toBe(1);
      expect(
        await harness.prisma.workeasy360SignIn.count({
          where: { subject: ada.sub, endedAt: null },
        }),
      ).toBe(0);
      expect(await refreshStatus(globex)).toBe(401);
      expect(await refreshStatus(bystander)).toBe(200);
    });

    it('ends nothing when the sid belongs to someone other than the sub it names', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      expect(
        (await deliver(await provider.logoutToken({ sub: ben.sub, sid: 'w360-laptop' }))).status,
      ).toBe(200);
      expect(await live(laptop)).toBe(1);
    });

    it('answers 200 for a sign-in that opened no session here, and for one already ended (at-least-once delivery)', async () => {
      expect(
        (await deliver(await provider.logoutToken({ sub: 'sub-nobody', sid: 'w360-elsewhere' })))
          .status,
      ).toBe(200);

      const laptop = await signIn(ada, 'w360-laptop');
      // Two deliveries of the same logout: every attempt carries a fresh token (and jti).
      expect(
        (await deliver(await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status,
      ).toBe(200);
      expect(
        (await deliver(await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status,
      ).toBe(200);
      expect(await live(laptop)).toBe(0);
      expect(await acceptedJtis()).toBe(3);
    });

    it.each<[string, LogoutTokenTweaks]>([
      ['another issuer', { iss: 'https://evil.example' }],
      ['another audience', { aud: 'another-products-client' }],
      ['a signature by a key the provider never published', { strangerKey: true }],
      ['an exp that has passed', { iatOffset: -300, expOffset: -120 }],
      ['a nonce', { extra: { nonce: 'n-1' } }],
      ['no events', { omit: ['events'] }],
      [
        'events without the back-channel logout event',
        { events: { 'http://example.test/other-event': {} } },
      ],
      ['no jti', { omit: ['jti'] }],
      ['no typ header (a plain JWT)', { typHeader: null }],
      ['the typ claim of an ID token', { typ: 'id_token' }],
    ])('refuses a token with %s with 400 and ends nothing', async (_name, tweak) => {
      const laptop = await signIn(ada, 'w360-laptop');
      const response = await deliver(
        await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }, tweak),
      );
      expectRefused(response);
      expect(await live(laptop)).toBe(1);
      expect(await acceptedJtis()).toBe(0);
      expect(
        await harness.prisma.workeasy360SignIn.count({ where: { endedAt: { not: null } } }),
      ).toBe(0);
      expect(await refreshStatus(laptop)).toBe(200);
    });

    it('refuses a replayed jti with 400, and the replay ends nothing', async () => {
      await signIn(ada, 'w360-laptop');
      const token = await provider.logoutToken(
        { sub: ada.sub, sid: 'w360-laptop' },
        { jti: 'jti-once' },
      );
      expect((await deliver(token)).status).toBe(200);

      // The same person opens Help Desk again under the same Workeasy360 sign-in; the captured
      // token, replayed, must not end the new session.
      const again = await signIn(ada, 'w360-laptop');
      expectRefused(await deliver(token));
      expect(await live(again)).toBe(1);
      expect(await acceptedJtis()).toBe(1);
      expect(await refreshStatus(again)).toBe(200);
    });

    it('refuses a request that carries no logout token form field', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const token = await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' });
      expectRefused(await request(http).post(BACKCHANNEL).type('form').send({ token }));
      expectRefused(await request(http).post(BACKCHANNEL).type('form').send(''));
      // The contract is a form post; a JSON body is not one.
      expectRefused(await request(http).post(BACKCHANNEL).send({ logout_token: token }));
      expectRefused(
        await request(http).post(BACKCHANNEL).type('form').send(`logout_token[]=${token}`),
      );
      expect(await live(laptop)).toBe(1);
    });

    it('needs no cookie and ignores the ones a browser would send', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const other = await signIn(ben, 'w360-ben');
      const response = await request(http)
        .post(BACKCHANNEL)
        .type('form')
        .set('Cookie', other.cookie)
        .send({ logout_token: await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }) });
      expect(response.status).toBe(200);
      expect(await live(laptop)).toBe(0);
      expect(await live(other)).toBe(1);
    });

    it('answers 503 and records nothing when ending the sessions fails, so the retry is accepted', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const { PrismaService } = await import('../src/prisma/prisma.service');
      const prisma = harness.app.get(PrismaService);
      const realTransaction = prisma.$transaction.bind(prisma) as (
        fn: (tx: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
      // The whole unit of work runs, then the database fails before it commits.
      jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (
        fn: (tx: unknown) => Promise<unknown>,
      ) =>
        realTransaction(async (tx) => {
          await fn(tx);
          throw new Error('the database went away');
        })) as never);

      const token = await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' });
      const failed = await deliver(token);
      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({ error: 'temporarily_unavailable' });
      expect(failed.headers['cache-control']).toBe('no-store');
      expect(await live(laptop)).toBe(1);
      expect(await acceptedJtis()).toBe(0);
      expect(
        await harness.prisma.workeasy360SignIn.count({ where: { endedAt: { not: null } } }),
      ).toBe(0);

      // Workeasy360 retries (here with the very same token): nothing was recorded, so it is accepted.
      expect((await deliver(token)).status).toBe(200);
      expect(await live(laptop)).toBe(0);
    });

    it('refreshes the key set once for an unknown kid; while the key set is down it answers 503 and the retry succeeds', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const bystander = await signIn(ben, 'w360-ben');
      // The client refreshes its cached key set for an unknown kid at most every 10 seconds.
      const wait = PAST_COOLDOWN_MS - (Date.now() - provider.lastJwksServedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

      await provider.rotateKey(); // Workeasy360 now signs with a key Help Desk has not seen
      const fetchesBefore = provider.jwksRequests;
      const token = await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' });

      provider.jwksFailure = 503;
      const unavailable = await deliver(token);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toEqual({ error: 'temporarily_unavailable' });
      expect(provider.jwksRequests).toBe(fetchesBefore + 1);
      expect(await live(laptop)).toBe(1);
      expect(await acceptedJtis()).toBe(0);

      provider.jwksFailure = null;
      expect((await deliver(token)).status).toBe(200);
      expect(provider.jwksRequests).toBe(fetchesBefore + 2); // exactly one refresh
      expect(await live(laptop)).toBe(0);

      // The refreshed key set is cached: the next token under the new kid fetches nothing.
      expect(
        (await deliver(await provider.logoutToken({ sub: ben.sub, sid: 'w360-ben' }))).status,
      ).toBe(200);
      expect(provider.jwksRequests).toBe(fetchesBefore + 2);
      expect(await live(bystander)).toBe(0);
    }, 60_000);

    it('a session renewed while its sign-in was being ended cannot be renewed again', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      expect(
        (await deliver(await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status,
      ).toBe(200);
      // A rotation that slipped in between the logout's revocation and its commit leaves an
      // unrevoked token in the family; the ended sign-in still stops it at the next refresh.
      await harness.prisma.refreshToken.updateMany({
        where: { familyId: laptop.familyId },
        data: { revokedAt: null },
      });
      expect(await refreshStatus(laptop)).toBe(401);
      expect(await live(laptop)).toBe(0);
    });

    it('accepts the event as an object even with members, and the application/logout+jwt type', async () => {
      const laptop = await signIn(ada, 'w360-laptop');
      const token = await provider.logoutToken(
        { sub: ada.sub, sid: 'w360-laptop' },
        { typHeader: 'application/logout+jwt', events: { [EVENT]: { reason: 'signed_out' } } },
      );
      expect((await deliver(token)).status).toBe(200);
      expect(await live(laptop)).toBe(0);
    });
  });
});
