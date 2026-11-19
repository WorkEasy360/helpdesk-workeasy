import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import type { Harness } from './app.harness';
import { FakeWorkeasy360, type Identity } from './support/fake-workeasy360';

/**
 * Ending a session ends its access tokens. A Help Desk session is a refresh-token family; every
 * access token names its family, and every request (and realtime handshake and re-check) is served
 * only while that family is live. So once a back-channel logout from Workeasy360 - or Sign out, or
 * anything else that revokes the family - ends a session, the access token the open tab still
 * holds is refused at once (401 SESSION_ENDED), on every route and every API instance, instead of
 * working on until it expires.
 *
 * The real application against real Postgres and Redis, and a fake Workeasy360 in this process
 * (test/support/fake-workeasy360.ts). Two (and, for a restart, three) application instances share
 * the database and Redis, as API instances behind the load balancer do. The tests play the
 * browser (start, sign in at the provider, callback, then the renewal the app makes as soon as it
 * lands, which is where it gets its access token) and the platform's delivery worker.
 *
 * The environment is set before the application module is first loaded, hence the dynamic imports.
 */

const FRONTEND = 'http://localhost:3000';
const REDIRECT_URI = `${FRONTEND}/api/auth/callback/workeasy360`;
const START = '/api/auth/workeasy360/start';
const CALLBACK = '/api/auth/callback/workeasy360';
const BACKCHANNEL = '/api/auth/workeasy360/backchannel-logout';
const FLOW_COOKIE = 'ds_w360_flow';
const REFRESH_COOKIE = 'ds_refresh';
/** Short, so the re-check backstop can be watched; the announcement must beat it anyway. */
const RECHECK_SECONDS = 3;

const ORG_A = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const ORG_B = '9a8c7d6e-5f4e-4d3c-8b2a-1a0b9c8d7e6f';
const ORG_C = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';

const ada: Identity = {
  sub: 'sub-ada',
  email: 'ada@acme.example',
  emailVerified: true,
  name: 'Ada Agent',
  organizationId: ORG_A,
  organizationName: 'Acme Support',
};
/** The same Workeasy360 person in a second organization: a second Help Desk user. */
const adaAtGlobex: Identity = { ...ada, email: 'ada@globex.example', organizationId: ORG_B, organizationName: 'Globex' };
/** Somebody else entirely, with an organization of their own. */
const ben: Identity = {
  sub: 'sub-ben',
  email: 'ben@initech.example',
  emailVerified: true,
  name: 'Ben Bystander',
  organizationId: ORG_C,
  organizationName: 'Initech',
};

interface Session {
  /** The refresh cookie as the browser holds it now (after the app's first renewal). */
  cookie: string;
  familyId: string;
  /** The access token the open tab holds. */
  token: string;
  bearer: { Authorization: string };
}

type Call = { method: 'get' | 'post' | 'patch'; path: string; body?: object };

describe('Ending a session ends its access tokens (e2e)', () => {
  let provider: FakeWorkeasy360;
  let helpers: typeof import('./app.harness');
  let one: Harness;
  let two: Harness;
  let hashRefreshToken: (raw: string) => string;
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const server = (instance: Harness): Server => instance.app.getHttpServer() as Server;
  const api = (path: string): string => `/api/v1${path}`;

  const pair = (response: request.Response, name: string): string | undefined =>
    ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(';')[0];

  /** A browser signing in through Workeasy360 on `instance`, then the app's first renewal. */
  async function signIn(instance: Harness, identity: Identity, sid?: string): Promise<Session> {
    const http = server(instance);
    const started = await request(http).get(START).expect(302);
    const authorization = provider.authorize(started.headers['location'] as string, identity, sid ? { sid } : {});
    if (!authorization.ok) throw new Error(`the provider refused (${authorization.error})`);
    const callback = await request(http)
      .get(`${CALLBACK}${new URL(authorization.callbackUrl).search}`)
      .set('Cookie', pair(started, FLOW_COOKIE)!)
      .expect(302);
    expect(callback.headers['location']).toBe(`${FRONTEND}/dashboard`);
    const renewed = await request(http).post(api('/auth/refresh')).set('Cookie', pair(callback, REFRESH_COOKIE)!).expect(200);
    const token = renewed.body.data.accessToken as string;
    const cookie = pair(renewed, REFRESH_COOKIE)!;
    const stored = await one.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(cookie.split('=')[1]!) },
      select: { familyId: true },
    });
    return { cookie, familyId: stored.familyId, token, bearer: { Authorization: `Bearer ${token}` } };
  }

  /** The platform's delivery: a form POST, no cookie, no CSRF token. */
  const deliver = (instance: Harness, token: string) =>
    request(server(instance)).post(BACKCHANNEL).type('form').send({ logout_token: token });

  const call = (instance: Harness, session: Session, { method, path, body }: Call) => {
    const pending = request(server(instance))[method](api(path)).set(session.bearer);
    return body ? pending.send(body) : pending;
  };

  const refreshStatus = async (instance: Harness, session: Session): Promise<number> =>
    (await request(server(instance)).post(api('/auth/refresh')).set('Cookie', session.cookie)).status;

  /** Protected operations, reads and writes, each with what it answers while the session is open. */
  async function protectedCalls(instance: Harness, session: Session): Promise<Array<[Call, number]>> {
    const contact = await call(instance, session, { method: 'post', path: '/contacts', body: { firstName: 'Casey' } }).expect(201);
    return [
      [{ method: 'get', path: '/auth/me' }, 200],
      [{ method: 'get', path: '/tickets' }, 200],
      [{ method: 'get', path: '/contacts' }, 200],
      [{ method: 'get', path: '/notifications' }, 200],
      [{ method: 'patch', path: '/auth/me', body: { firstName: 'Renamed' } }, 200],
      [{ method: 'post', path: '/contacts', body: { firstName: 'Another' } }, 201],
      [
        {
          method: 'post',
          path: '/tickets',
          body: { subject: 'Printer on fire', description: 'Smoke everywhere', contactId: contact.body.data.id as string },
        },
        201,
      ],
    ];
  }

  async function expectSessionEnded(instance: Harness, session: Session, calls: Array<[Call, number]>): Promise<void> {
    for (const [operation] of calls) {
      const response = await call(instance, session, operation);
      expect({ operation: `${operation.method} ${operation.path}`, status: response.status }).toEqual({
        operation: `${operation.method} ${operation.path}`,
        status: 401,
      });
      expect(response.body.error.code).toBe('SESSION_ENDED');
    }
  }

  const userOf = (identity: Identity) =>
    one.prisma.user.findFirstOrThrow({
      where: { email: identity.email },
      select: { id: true, firstName: true, organizationId: true },
    });

  // --- lifecycle -----------------------------------------------------------------

  beforeAll(async () => {
    provider = await FakeWorkeasy360.start({ redirectUri: REDIRECT_URI, appPublicKey: appKeys.publicKey });
    Object.assign(process.env, {
      WORKEASY360_ISSUER: provider.issuer,
      WORKEASY360_CLIENT_ID: provider.clientId,
      WORKEASY360_REDIRECT_URI: REDIRECT_URI,
      WORKEASY360_KEY_ID: provider.keyId,
      WORKEASY360_PRIVATE_KEY: appKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      // As in production: Workeasy360 is the only way in.
      WORKEASY360_SSO_ONLY: 'true',
      REALTIME_ACCESS_RECHECK_SECONDS: String(RECHECK_SECONDS),
    });
    helpers = await import('./app.harness');
    one = await helpers.createHarness();
    two = await helpers.createHarness();
    const { TokenService } = await import('../src/auth/token.service');
    const tokens = one.app.get(TokenService);
    hashRefreshToken = (raw) => tokens.hashRefreshToken(raw);
  }, 240_000);

  beforeEach(async () => {
    await helpers.resetDatabase(one.prisma, one.redis);
    provider.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await two?.close();
    await one?.close();
    await provider?.stop();
  });

  // --- a logout token -------------------------------------------------------------------------

  describe('a back-channel logout', () => {
    it('refuses the access token the tab holds on every protected route, read and write; its refresh fails; other sessions carry on', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const phone = await signIn(one, ada, 'w360-phone'); // the same person, another Workeasy360 sign-in
      const bystander = await signIn(one, ben, 'w360-ben');

      const calls = await protectedCalls(one, laptop);
      for (const [operation, status] of calls) {
        expect((await call(one, laptop, operation)).status).toBe(status);
      }
      const contactsBefore = await one.prisma.contact.count();
      const ticketsBefore = await one.prisma.ticket.count();
      const before = await userOf(ada);

      expect((await deliver(one, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);

      // The same token, long before it expires: refused everywhere, and the writes change nothing.
      await expectSessionEnded(one, laptop, calls);
      expect(await one.prisma.contact.count()).toBe(contactsBefore);
      expect(await one.prisma.ticket.count()).toBe(ticketsBefore);
      expect((await userOf(ada)).firstName).toBe(before.firstName);
      // A page refresh cannot bring it back: the renewal fails.
      expect(await refreshStatus(one, laptop)).toBe(401);
      await expectSessionEnded(one, laptop, [[{ method: 'get', path: '/auth/me' }, 200]]);

      // The person's other sign-in, and somebody else, are untouched.
      for (const other of [phone, bystander]) {
        await call(one, other, { method: 'get', path: '/auth/me' }).expect(200);
        await call(one, other, { method: 'post', path: '/contacts', body: { firstName: 'Still here' } }).expect(201);
        expect(await refreshStatus(one, other)).toBe(200);
      }
    });

    it('naming only the person ("sign out everywhere") refuses every access token of theirs, in every organization, and nobody else\'s', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const phone = await signIn(one, ada, 'w360-phone');
      const globex = await signIn(one, adaAtGlobex, 'w360-globex');
      const bystander = await signIn(one, ben, 'w360-ben');
      for (const session of [laptop, phone, globex, bystander]) {
        await call(one, session, { method: 'get', path: '/tickets' }).expect(200);
      }

      expect((await deliver(one, await provider.logoutToken({ sub: ada.sub }))).status).toBe(200);

      for (const session of [laptop, phone, globex]) {
        await expectSessionEnded(one, session, [
          [{ method: 'get', path: '/tickets' }, 200],
          [{ method: 'post', path: '/contacts', body: { firstName: 'Nope' } }, 201],
        ]);
        expect(await refreshStatus(one, session)).toBe(401);
      }
      await call(one, bystander, { method: 'get', path: '/tickets' }).expect(200);
      expect(await refreshStatus(one, bystander)).toBe(200);
    });

    it('stays idempotent: a retried delivery changes nothing more, a replayed token is still refused, and the ended token stays refused', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const bystander = await signIn(one, ben, 'w360-ben');
      const first = await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }, { jti: 'jti-first' });
      expect((await deliver(one, first)).status).toBe(200);
      await call(one, laptop, { method: 'get', path: '/auth/me' }).expect(401);

      // Workeasy360 retries with a fresh token (a fresh jti): accepted, nothing more ends.
      expect((await deliver(two, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);
      // The captured first token, replayed: refused as before.
      const replay = await deliver(two, first);
      expect(replay.status).toBe(400);
      expect(replay.body).toEqual({ error: 'invalid_request' });

      await call(one, laptop, { method: 'get', path: '/auth/me' }).expect(401);
      await call(one, bystander, { method: 'get', path: '/auth/me' }).expect(200);
      expect(await one.prisma.workeasy360LogoutToken.count()).toBe(2);
    });

    it('refuses a token renewed while the logout was being processed (the sign-in ended, even if a refresh token escaped)', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      expect((await deliver(one, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);
      // A rotation that slipped in between the logout's revocation and its commit leaves an
      // unrevoked refresh token in the family. The ended sign-in still ends its access tokens.
      await one.prisma.refreshToken.updateMany({ where: { familyId: laptop.familyId }, data: { revokedAt: null } });
      await call(one, laptop, { method: 'get', path: '/auth/me' }).expect(401);
      await call(two, laptop, { method: 'post', path: '/contacts', body: { firstName: 'Late' } }).expect(401);
    });
  });

  describe('the app\'s own sign-out', () => {
    it('refuses the access token the tab holds as well, not just the refresh cookie', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const bystander = await signIn(one, ben, 'w360-ben');
      await call(one, laptop, { method: 'get', path: '/auth/me' }).expect(200);

      await request(server(one)).post(api('/auth/logout')).set('Cookie', laptop.cookie).expect(200);

      await expectSessionEnded(one, laptop, [
        [{ method: 'get', path: '/auth/me' }, 200],
        [{ method: 'patch', path: '/auth/me', body: { firstName: 'After' } }, 200],
      ]);
      expect(await refreshStatus(one, laptop)).toBe(401);
      await call(one, bystander, { method: 'get', path: '/auth/me' }).expect(200);
    });
  });

  // --- every instance, and restarts ------------------------------------------------------------

  describe('shared by every API instance', () => {
    it('a logout delivered to one instance is enforced at once by the other, and by an instance started afterwards', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const bystander = await signIn(two, ben, 'w360-ben');
      // Stateless until now: either instance serves either token.
      for (const instance of [one, two]) {
        await call(instance, laptop, { method: 'get', path: '/auth/me' }).expect(200);
        await call(instance, bystander, { method: 'get', path: '/auth/me' }).expect(200);
      }

      expect((await deliver(two, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);

      for (const instance of [one, two]) {
        await expectSessionEnded(instance, laptop, [
          [{ method: 'get', path: '/tickets' }, 200],
          [{ method: 'post', path: '/contacts', body: { firstName: 'Nope' } }, 201],
        ]);
        await call(instance, bystander, { method: 'get', path: '/tickets' }).expect(200);
      }
      expect(await refreshStatus(one, laptop)).toBe(401);

      // An instance started after the logout (fresh process state, nothing remembered in memory).
      const restarted = await helpers.createHarness();
      try {
        await expectSessionEnded(restarted, laptop, [[{ method: 'get', path: '/auth/me' }, 200]]);
        expect(await refreshStatus(restarted, laptop)).toBe(401);
        await call(restarted, bystander, { method: 'get', path: '/auth/me' }).expect(200);
      } finally {
        await restarted.close();
      }
    });
  });

  // --- the realtime channel ----------------------------------------------------------------------

  describe('realtime (/rt)', () => {
    const urls = new Map<Harness, string>();
    const open: { close: () => void }[] = [];

    beforeAll(async () => {
      for (const instance of [one, two]) {
        await instance.app.listen(0);
        urls.set(instance, `http://127.0.0.1:${(server(instance).address() as AddressInfo).port}`);
      }
    });

    afterEach(() => {
      for (const socket of open.splice(0)) socket.close();
    });

    async function connect(instance: Harness, token: string) {
      const { io } = await import('socket.io-client');
      const socket = io(`${urls.get(instance)!}/rt`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      open.push(socket);
      const events: string[] = [];
      socket.onAny((name: string) => events.push(name));
      const disconnected = new Promise<string>((resolve) => socket.on('disconnect', resolve));
      const connected = new Promise<void>((resolve) => socket.on('connect', resolve));
      /** Resolves with the time `session.ended` arrived. */
      const ended = new Promise<number>((resolve) => socket.on('session.ended', () => resolve(Date.now())));
      return { socket, events, disconnected, connected, ended };
    }

    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
      Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);

    it('drops the sockets of the ended session at once, on every instance, and refuses its next handshake; other sessions stay connected', async () => {
      const { RealtimeGateway } = await import('../src/realtime/realtime.gateway');
      const announced = jest.spyOn(RealtimeGateway.prototype, 'endSessions');
      const laptop = await signIn(one, ada, 'w360-laptop');
      const phone = await signIn(one, ada, 'w360-phone');
      const bystander = await signIn(one, ben, 'w360-ben');

      const onOne = await connect(one, laptop.token);
      const onTwo = await connect(two, laptop.token);
      const phoneSocket = await connect(two, phone.token);
      const benSocket = await connect(one, bystander.token);
      await Promise.all([onOne.connected, onTwo.connected, phoneSocket.connected, benSocket.connected]);
      await settle(300); // in their rooms

      const sent = Date.now();
      expect((await deliver(two, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);

      // Told and dropped on both instances, well inside one re-check.
      for (const socket of [onOne, onTwo]) {
        const at = await within(socket.ended, 2000, 'the socket was never told its session ended');
        expect(at - sent).toBeLessThan(RECHECK_SECONDS * 1000);
        expect(await within(socket.disconnected, 2000, 'the socket was not dropped')).toBe('io server disconnect');
      }
      // Both instances heard the announcement (that is what dropped them, not a re-check).
      const families = announced.mock.calls.map(([named]) => named);
      expect(families.filter((named) => named.includes(laptop.familyId)).length).toBeGreaterThanOrEqual(2);

      // Through a re-check, the other sessions are still there.
      await settle(RECHECK_SECONDS * 1000 + 500);
      for (const socket of [phoneSocket, benSocket]) {
        expect(socket.socket.connected).toBe(true);
        expect(socket.events).not.toContain('session.ended');
      }

      // A new handshake with the ended session's token is told why and refused.
      const again = await connect(one, laptop.token);
      await within(again.ended, 3000, 'the handshake was not told the session ended');
      expect(await within(again.disconnected, 3000, 'the handshake was not refused')).toBe('io server disconnect');
      expect(again.events).not.toContain('agent.online');
    });

    it('drops a socket whose session ended without an announcement at its next re-check', async () => {
      const { SessionLivenessService } = await import('../src/auth/session-liveness.service');
      // As if the announcement were lost (Redis briefly away): only the re-check is left.
      jest.spyOn(SessionLivenessService.prototype, 'announceEnded').mockResolvedValue(undefined);
      const laptop = await signIn(one, ada, 'w360-laptop');
      const bystander = await signIn(one, ben, 'w360-ben');
      const dropped = await connect(one, laptop.token);
      const kept = await connect(one, bystander.token);
      await Promise.all([dropped.connected, kept.connected]);

      expect((await deliver(one, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);

      await within(dropped.ended, RECHECK_SECONDS * 1000 + 3000, 'the re-check did not end the socket');
      expect(await within(dropped.disconnected, 2000, 'the socket was not dropped')).toBe('io server disconnect');
      expect(kept.socket.connected).toBe(true);
    });
  });

  // --- the token itself --------------------------------------------------------------------------

  describe('tokens and outages', () => {
    it('refuses an access token that names no session (issued before this release); the renewal the app makes replaces it', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const { TokenService } = await import('../src/auth/token.service');
      const tokens = one.app.get(TokenService);
      const verified = tokens.verifyAccessToken(laptop.token);
      if (!verified.ok) throw new Error('the token did not verify');
      const { fam, ...older } = verified.payload as typeof verified.payload & { exp?: number; iat?: number };
      expect(fam).toBe(laptop.familyId);
      delete older.exp;
      delete older.iat;
      const legacy = tokens.signAccessToken(older as unknown as Parameters<typeof tokens.signAccessToken>[0]);

      const refused = await request(server(one)).get(api('/auth/me')).set('Authorization', `Bearer ${legacy}`).expect(401);
      expect(refused.body.error.code).toBe('SESSION_ENDED');
      // What the app does on any 401: one renewal, which mints a token that names the session.
      const renewed = await request(server(one)).post(api('/auth/refresh')).set('Cookie', laptop.cookie).expect(200);
      await request(server(one))
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${renewed.body.data.accessToken as string}`)
        .expect(200);
    });

    it('answers 503, not 401, when the session cannot be checked, so the app does not sign anyone out', async () => {
      const laptop = await signIn(one, ada, 'w360-laptop');
      const { SessionLivenessService } = await import('../src/auth/session-liveness.service');
      jest.spyOn(SessionLivenessService.prototype, 'state').mockRejectedValueOnce(new Error('the database went away'));

      const unavailable = await call(one, laptop, { method: 'get', path: '/tickets' });
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.code).toBe('SERVICE_UNAVAILABLE');
      await call(one, laptop, { method: 'get', path: '/tickets' }).expect(200);
    });

    it('a help center customer\'s token ends with the customer\'s sign-out, and an ended agent token is no identity on the help center', async () => {
      const agent = await signIn(one, ada, 'w360-laptop');
      const center = await call(one, agent, { method: 'get', path: '/help-center' }).expect(200);
      const portal = (path: string) => api(`/portal/${center.body.data.slug as string}${path}`);
      const customer = await request(server(one))
        .post(portal('/auth/register'))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const customerBearer = { Authorization: `Bearer ${customer.body.data.accessToken as string}` };
      const customerCookie = pair(customer, 'ds_portal_refresh')!;
      await request(server(one)).get(portal('/tickets')).set(customerBearer).expect(200);
      await request(server(one)).get(portal('')).set(agent.bearer).expect(200);

      await request(server(one)).post(portal('/auth/logout')).set('Cookie', customerCookie).expect(200);
      const refused = await request(server(two)).get(portal('/tickets')).set(customerBearer).expect(401);
      expect(refused.body.error.code).toBe('SESSION_ENDED');

      expect((await deliver(one, await provider.logoutToken({ sub: ada.sub, sid: 'w360-laptop' }))).status).toBe(200);
      const agentRefused = await request(server(two)).get(portal('')).set(agent.bearer).expect(401);
      expect(agentRefused.body.error.code).toBe('SESSION_ENDED');
      // Without a token the help center is still served to anonymous visitors.
      await request(server(two)).get(portal('')).expect(200);
    });
  });
});
