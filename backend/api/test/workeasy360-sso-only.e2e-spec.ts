import request from 'supertest';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Harness } from './app.harness';
import { FakeWorkeasy360, type Identity } from './support/fake-workeasy360';

/**
 * SSO-only: Workeasy360 is the only way agents sign in. Password sign-in, registration,
 * reset, change and invitations are refused; the customer portal is untouched; an
 * administrator can still pre-provision an agent, who signs in through Workeasy360 and is
 * linked by verified address.
 */

const FRONTEND = 'http://localhost:3000';
const REDIRECT_URI = `${FRONTEND}/api/auth/callback/workeasy360`;
const ORG_A = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const ORG_B = '9a8c7d6e-5f4e-4d3c-8b2a-1a0b9c8d7e6f';
const apiPath = (path: string): string => `/api/v1${path}`;

// COOKIE_SECURE is on here, so the session and flow cookies are `__Host-` cookies.
const REFRESH_COOKIE = '__Host-ds_refresh';
const FLOW_COOKIE = '__Host-ds_w360_flow';
const COOKIE_DOMAIN = '.example.test';

const owner: Identity = {
  sub: 'sub-owner',
  email: 'owner@acme.example',
  emailVerified: true,
  name: 'Olive Owner',
  organizationId: ORG_A,
  organizationName: 'Acme Support',
};

describe('Workeasy360 as the only way in (e2e)', () => {
  let provider: FakeWorkeasy360;
  let harness: Harness;
  let http: Server;
  let helpers: typeof import('./app.harness');
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const pair = (response: request.Response, name: string): string | undefined =>
    ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .find((cookie) => cookie.startsWith(`${name}=`) && !cookie.startsWith(`${name}=;`))
      ?.split(';')[0];

  async function signIn(identity: Identity): Promise<request.Response> {
    const started = await request(http).get('/api/auth/workeasy360/start').expect(302);
    const authorization = provider.authorize(started.headers['location'] as string, identity);
    if (!authorization.ok) throw new Error('the provider refused');
    const url = new URL(authorization.callbackUrl);
    return request(http)
      .get(`${url.pathname}${url.search}`)
      .set('Cookie', pair(started, FLOW_COOKIE)!);
  }

  const decode = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

  async function ownerSession() {
    const callback = await signIn(owner);
    expect(callback.headers['location']).toBe(`${FRONTEND}/dashboard`);
    const refreshed = await request(http)
      .post(apiPath('/auth/refresh'))
      .set('Cookie', pair(callback, REFRESH_COOKIE)!)
      .expect(200);
    return { bearer: { Authorization: `Bearer ${refreshed.body.data.accessToken as string}` } };
  }

  beforeAll(async () => {
    provider = await FakeWorkeasy360.start({ redirectUri: REDIRECT_URI, appPublicKey: appKeys.publicKey });
    Object.assign(process.env, {
      WORKEASY360_ISSUER: provider.issuer,
      WORKEASY360_CLIENT_ID: provider.clientId,
      WORKEASY360_REDIRECT_URI: REDIRECT_URI,
      WORKEASY360_KEY_ID: provider.keyId,
      WORKEASY360_PRIVATE_KEY: appKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      WORKEASY360_SSO_ONLY: '1',
      // Secure cookies on: the flow cookie then carries the __Secure- prefix.
      COOKIE_SECURE: 'true',
      // A parent-domain setting must not leak into the `__Host-` cookies (they can have no Domain).
      COOKIE_DOMAIN,
      REALTIME_ACCESS_RECHECK_SECONDS: '1',
    });
    helpers = await import('./app.harness');
    harness = await helpers.createHarness();
    http = harness.app.getHttpServer() as Server;
  }, 240_000);

  beforeEach(async () => {
    await helpers.resetDatabase(harness.prisma, harness.redis);
    provider.reset();
  });

  afterAll(async () => {
    await harness?.close();
    await provider?.stop();
  });

  it('tells the sign-in page there is no password form, and no way to register', async () => {
    const methods = await request(http).get(apiPath('/auth/methods')).expect(200);
    expect(methods.body.data).toEqual({ password: false, workeasy360: true, workeasy360SignOut: false });
    const registration = await request(http).get(apiPath('/auth/register')).expect(200);
    expect(registration.body.data).toEqual({ enabled: false });
  });

  describe('password routes for agents are refused (PASSWORD_SIGN_IN_DISABLED)', () => {
    const refused = async (response: Promise<request.Response> | request.Test) => {
      const result = await response;
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('PASSWORD_SIGN_IN_DISABLED');
      expect(result.headers['set-cookie']).toBeUndefined();
    };

    it('login, even with the right password', async () => {
      // A legacy account that still holds a password hash cannot use it.
      const org = await harness.prisma.organization.create({ data: { name: 'Old', slug: 'old' } });
      const passwords = new (await import('../src/auth/password.service')).PasswordService();
      await harness.prisma.user.create({
        data: {
          organizationId: org.id,
          email: 'old@old.example',
          firstName: 'Old',
          lastName: 'Timer',
          type: 'AGENT',
          passwordHash: await passwords.hash('Str0ngPassword1'),
        },
      });
      await refused(
        request(http).post(apiPath('/auth/login')).send({ email: 'old@old.example', password: 'Str0ngPassword1' }),
      );
    });

    it('registration', async () => {
      await refused(
        request(http).post(apiPath('/auth/register')).send({
          organizationName: 'New Co',
          organizationSlug: 'new-co',
          firstName: 'N',
          lastName: 'C',
          email: 'n@new.example',
          password: 'Str0ngPassword1',
        }),
      );
      expect(await harness.prisma.organization.count()).toBe(0);
    });

    it('forgot-password and reset-password', async () => {
      await refused(request(http).post(apiPath('/auth/forgot-password')).send({ email: 'a@b.example' }));
      await refused(
        request(http).post(apiPath('/auth/reset-password')).send({ token: 'x'.repeat(30), password: 'Str0ngPassword1' }),
      );
    });

    it('change-password, for a signed-in agent', async () => {
      const owned = await ownerSession();
      await refused(
        request(http)
          .post(apiPath('/auth/change-password'))
          .set(owned.bearer)
          .send({ currentPassword: 'whatever-it-was', newPassword: 'An0therPassword2' }),
      );
    });

    it('invitation emails', async () => {
      const owned = await ownerSession();
      const created = await request(http)
        .post(apiPath('/users'))
        .set(owned.bearer)
        .send({ firstName: 'Ada', lastName: 'Agent', email: 'ada@acme.example', roleIds: [await roleId('AGENT')] })
        .expect(201);
      await refused(request(http).post(apiPath(`/users/${created.body.data.id as string}/invite`)).set(owned.bearer));
    });

    it('setting a password on a new agent', async () => {
      const owned = await ownerSession();
      await refused(
        request(http)
          .post(apiPath('/users'))
          .set(owned.bearer)
          .send({
            firstName: 'Ada',
            lastName: 'Agent',
            email: 'ada@acme.example',
            password: 'Str0ngPassword1',
            roleIds: [await roleId('AGENT')],
          }),
      );
      expect(await harness.prisma.user.count({ where: { email: 'ada@acme.example' } })).toBe(0);
    });
  });

  async function roleId(systemKey: string): Promise<string> {
    return (await harness.prisma.role.findFirstOrThrow({ where: { systemKey } })).id;
  }

  describe('administrators can still pre-provision agents', () => {
    it('creates the agent without a password and without mailing anyone, and Workeasy360 sign-in links them by verified address', async () => {
      const owned = await ownerSession();
      const { MailerService } = await import('../src/email/mailer.service');
      const mailer = harness.app.get(MailerService);
      const sent = jest.spyOn(mailer, 'send');

      const created = await request(http)
        .post(apiPath('/users'))
        .set(owned.bearer)
        .send({ firstName: 'Ada', lastName: 'Agent', email: 'ada@acme.example', roleIds: [await roleId('LIGHT_AGENT')] })
        .expect(201);
      expect(sent).not.toHaveBeenCalled();
      sent.mockRestore();

      const stored = await harness.prisma.user.findUniqueOrThrow({ where: { id: created.body.data.id as string } });
      expect(stored.passwordHash).toBeNull();

      const callback = await signIn({ ...owner, sub: 'sub-ada', email: 'ada@acme.example', name: 'Ada Agent' });
      expect(callback.headers['location']).toBe(`${FRONTEND}/dashboard`);
      const linked = await harness.prisma.user.findUniqueOrThrow({
        where: { id: stored.id },
        include: { externalIdentities: true, roles: { include: { role: true } } },
      });
      expect(linked.externalIdentities.map((i) => i.subject)).toEqual(['sub-ada']);
      expect(linked.roles.map((r) => r.role.systemKey)).toEqual(['LIGHT_AGENT']);
      expect(await harness.prisma.user.count()).toBe(2);
    });
  });

  it('signs agents in through Workeasy360 as usual', async () => {
    const owned = await ownerSession();
    const me = await request(http).get(apiPath('/auth/me')).set(owned.bearer).expect(200);
    expect(me.body.data.email).toBe('owner@acme.example');
  });

  describe('the customer portal is unaffected', () => {
    it('keeps customer registration, sign-in, password reset and tickets working', async () => {
      const owned = await ownerSession();
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const slug = center.body.data.slug as string;
      const portal = (path: string) => apiPath(`/portal/${slug}${path}`);

      const registered = await request(http)
        .post(portal('/auth/register'))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const customer = { Authorization: `Bearer ${registered.body.data.accessToken as string}` };

      await request(http)
        .post(portal('/auth/login'))
        .send({ email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(200);
      await request(http).post(portal('/auth/forgot-password')).send({ email: 'rhea@example.com' }).expect(200);
      const created = await request(http)
        .post(portal('/tickets'))
        .set(customer)
        .send({ subject: 'Export crashes', description: 'Above 500 rows the tab dies.' })
        .expect(201);
      expect(created.body.data.subject).toBe('Export crashes');
      await request(http).get(portal('/tickets')).set(customer).expect(200);
    });
  });

  // --- sessions that predate SSO-only ------------------------------------------------------

  describe('password-era sessions (SSO-only)', () => {
    async function passwordEraAgent(bound: boolean) {
      const { provisionSystemRoles, provisionHelpCenter } = await import('@digisoft/db');
      const { AuthService } = await import('../src/auth/auth.service');
      const org = await harness.prisma.organization.create({
        data: { name: 'Old Co', slug: bound ? 'old-bound' : 'old-plain', ...(bound ? { workeasy360OrganizationId: ORG_A } : {}) },
      });
      const roleIds = await provisionSystemRoles(harness.prisma, org.id);
      await provisionHelpCenter(harness.prisma, org.id, { name: 'Old Co', slug: org.slug });
      const user = await harness.prisma.user.create({
        data: {
          organizationId: org.id,
          email: 'old@old.example',
          firstName: 'Old',
          lastName: 'Timer',
          type: 'AGENT',
          roles: { create: { roleId: roleIds['SUPER_ADMIN']! } },
        },
      });
      const auth = harness.app.get(AuthService);
      const session = await auth.createSession(user.id, org.id, { ip: null, userAgent: null });
      return { org, user, session, auth, cookie: `${REFRESH_COOKIE}=${session.refreshToken}`, bearer: { Authorization: `Bearer ${session.accessToken}` } };
    }

    it('records how a session was started: a Workeasy360 sign-in is tagged, and every refresh keeps the tag', async () => {
      const callback = await signIn(owner);
      let cookie = pair(callback, REFRESH_COOKIE)!;
      for (let i = 0; i < 2; i += 1) {
        const renewed = await request(http).post(apiPath('/auth/refresh')).set('Cookie', cookie).expect(200);
        cookie = pair(renewed, REFRESH_COOKIE)!;
      }
      const tokens = await harness.prisma.refreshToken.findMany();
      expect(tokens.length).toBe(3);
      expect(tokens.every((t) => t.authMethod === 'WORKEASY360')).toBe(true);
    });

    it('refuses the access token of a bound organization\'s account that has no Workeasy360 identity', async () => {
      const old = await passwordEraAgent(true);
      expect(decode(old.session.accessToken)['w360']).toEqual({ org: ORG_A });
      for (const route of ['/tickets', '/auth/me', '/departments']) {
        const refused = await request(http).get(apiPath(route)).set(old.bearer).expect(403);
        expect(refused.body.error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
      }
      await request(http).patch(apiPath('/auth/me')).set(old.bearer).send({ firstName: 'X' }).expect(403);
      // Nothing was asked of Workeasy360 for it.
      expect(provider.entitlementCalls).toHaveLength(0);
    });

    it('refuses to renew a password-method family, and leaves the token untouched', async () => {
      const old = await passwordEraAgent(true);
      const refused = await request(http).post(apiPath('/auth/refresh')).set('Cookie', old.cookie).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
      expect(refused.headers['set-cookie']).toBeUndefined();
      const token = await harness.prisma.refreshToken.findFirstOrThrow({ where: { userId: old.user.id } });
      expect(token.revokedAt).toBeNull();
      expect(token.authMethod).toBe('PASSWORD');
    });

    it('refuses a password-method family in an organization that is not bound to Workeasy360 either', async () => {
      const old = await passwordEraAgent(false);
      const refused = await request(http).post(apiPath('/auth/refresh')).set('Cookie', old.cookie).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
    });

    it('refuses a Workeasy360-method family whose account has no identity in a bound organization', async () => {
      const old = await passwordEraAgent(true);
      const session = await old.auth.createSession(old.user.id, old.org.id, { ip: null, userAgent: null }, undefined, 'WORKEASY360');
      await request(http)
        .post(apiPath('/auth/refresh'))
        .set('Cookie', `${REFRESH_COOKIE}=${session.refreshToken}`)
        .expect(403)
        .expect((r) => expect(r.body.error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED'));
    });

    it('signing in with Workeasy360 links the account by verified address and the old session stays refused', async () => {
      const old = await passwordEraAgent(true);
      const callback = await signIn({ ...owner, email: 'old@old.example' });
      expect(callback.headers['location']).toBe(`${FRONTEND}/dashboard`);
      const identities = await harness.prisma.externalIdentity.findMany({ where: { userId: old.user.id } });
      expect(identities).toHaveLength(1);
      // The link revoked what the password issued...
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', old.cookie).expect(401);
      // ...and the new session is a normal one.
      const renewed = await request(http).post(apiPath('/auth/refresh')).set('Cookie', pair(callback, REFRESH_COOKIE)!).expect(200);
      await request(http)
        .get(apiPath('/auth/me'))
        .set('Authorization', `Bearer ${renewed.body.data.accessToken as string}`)
        .expect(200);
    });

    it('does not touch customers: their help center sessions renew as before', async () => {
      await signIn(owner);
      const organization = await harness.prisma.organization.findFirstOrThrow();
      const center = await harness.prisma.helpCenter.findFirstOrThrow({ where: { organizationId: organization.id } });
      const registered = await request(http)
        .post(apiPath(`/portal/${center.slug}/auth/register`))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const cookie = pair(registered, 'ds_portal_refresh')!;
      await request(http).post(apiPath(`/portal/${center.slug}/auth/refresh`)).set('Cookie', cookie).expect(200);
    });

    it('refuses a password-era agent on the help center too', async () => {
      const old = await passwordEraAgent(true);
      const center = await harness.prisma.helpCenter.findFirstOrThrow({ where: { organizationId: old.org.id } });
      const refused = await request(http).get(apiPath(`/portal/${center.slug}/kb/categories`)).set(old.bearer).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
    });
  });

  // --- the flow cookie --------------------------------------------------------------------

  const setCookiesOf = (response: request.Response): string[] =>
    (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const live = (response: request.Response, name: string): string | undefined =>
    setCookiesOf(response).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));

  describe('the flow cookie with Secure cookies on', () => {
    it('is a __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain (a sibling subdomain cannot plant it)', async () => {
      const started = await request(http).get('/api/auth/workeasy360/start').expect(302);
      const header = live(started, '__Host-ds_w360_flow')!;
      expect(header).toBeDefined();
      expect(header).toMatch(/;\s*Secure/i);
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(header).toContain('Path=/;');
      expect(header).not.toContain('Path=/api');
      expect(header).not.toMatch(/Domain=/i);
      // Neither the old __Secure- name nor the plain one is set.
      expect(setCookiesOf(started).some((c) => c.startsWith('__Secure-ds_w360_flow=') || c.startsWith('ds_w360_flow='))).toBe(false);
    });

    it('is cleared at the callback with the same attributes (Path=/, Secure, no Domain)', async () => {
      const callback = await signIn(owner);
      const cleared = setCookiesOf(callback).find((c) => c.startsWith('__Host-ds_w360_flow=;'))!;
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Path=/;');
      expect(cleared).toMatch(/;\s*Secure/i);
      expect(cleared).not.toMatch(/Domain=/i);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });

    it('is the only name read: a planted copy under another name (the names a sibling subdomain can set) is ignored', async () => {
      // The attacker starts their own flow in their own browser, then plants its cookie under the
      // names a sibling subdomain CAN set (Domain=.parent). The victim's callback must not use it.
      const attackerStart = await request(http).get('/api/auth/workeasy360/start').expect(302);
      const attackerFlow = pair(attackerStart, FLOW_COOKIE)!.split('=')[1]!;
      const authorization = provider.authorize(attackerStart.headers['location'] as string, owner);
      if (!authorization.ok) throw new Error('the provider refused');
      const url = new URL(authorization.callbackUrl);

      for (const planted of ['__Secure-ds_w360_flow', 'ds_w360_flow']) {
        const callback = await request(http)
          .get(`${url.pathname}${url.search}`)
          .set('Cookie', `${planted}=${attackerFlow}`);
        expect(callback.status).toBe(302);
        expect(callback.headers['location']).toBe(`${FRONTEND}/login?sso_error=expired`);
        expect(live(callback, REFRESH_COOKIE)).toBeUndefined();
      }
      expect(await harness.prisma.refreshToken.count()).toBe(0);
    });
  });

  // --- the session cookie -----------------------------------------------------------------

  describe('the session cookie with Secure cookies on', () => {
    it('is a __Host- cookie: Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain, even with COOKIE_DOMAIN set', async () => {
      const callback = await signIn(owner);
      const header = live(callback, REFRESH_COOKIE)!;
      expect(header).toBeDefined();
      expect(header).toMatch(/;\s*Secure/i);
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(header).toContain('Path=/;');
      expect(header).not.toContain('Path=/api');
      expect(header).not.toMatch(/Domain=/i);
      expect(header).toMatch(/Max-Age=|Expires=/i);
      // The unprefixed cookie is not set anew, and the ones earlier releases left are expired.
      expect(live(callback, 'ds_refresh')).toBeUndefined();
      const expired = setCookiesOf(callback).filter((c) => c.startsWith('ds_refresh=;'));
      expect(expired.some((c) => c.includes('Path=/api;'))).toBe(true);
      expect(expired.some((c) => c.includes('Path=/api/v1/auth'))).toBe(true);
      expect(expired.every((c) => c.includes(`Domain=${COOKIE_DOMAIN}`))).toBe(true);
    });

    it('is rotated, read and cleared under the new name', async () => {
      const callback = await signIn(owner);
      const first = pair(callback, REFRESH_COOKIE)!;

      const renewed = await request(http).post(apiPath('/auth/refresh')).set('Cookie', first).expect(200);
      const second = pair(renewed, REFRESH_COOKIE)!;
      expect(second).not.toBe(first);
      expect(live(renewed, REFRESH_COOKIE)).toContain('Path=/;');

      const out = await request(http).post(apiPath('/auth/logout')).set('Cookie', second).expect(200);
      const cleared = setCookiesOf(out).find((c) => c.startsWith(`${REFRESH_COOKIE}=;`))!;
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Path=/;');
      expect(cleared).toMatch(/;\s*Secure/i);
      expect(cleared).not.toMatch(/Domain=/i);
      // The session really ended.
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', second).expect(401);
    });

    it('ignores an unprefixed ds_refresh: a sibling subdomain can plant one, so it is never trusted', async () => {
      const callback = await signIn(owner);
      const prefixed = pair(callback, REFRESH_COOKIE)!;
      const token = prefixed.split('=')[1]!;

      // Only the unprefixed copy (a perfectly valid token, say): no session.
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', `ds_refresh=${token}`).expect(401);

      // Both: the unprefixed one never wins, whichever order a browser sends them in.
      const victim = await request(http).post(apiPath('/auth/refresh')).set('Cookie', `ds_refresh=planted; ${prefixed}`).expect(200);
      const next = pair(victim, REFRESH_COOKIE)!;
      expect(next).toBeDefined();
      const reversed = await request(http)
        .post(apiPath('/auth/refresh'))
        .set('Cookie', `${next}; ds_refresh=planted`)
        .expect(200);
      expect(pair(reversed, REFRESH_COOKIE)).toBeDefined();

      // A sign-out presented only under the unprefixed name ends nothing.
      const stillLive = pair(reversed, REFRESH_COOKIE)!;
      await request(http).post(apiPath('/auth/logout')).set('Cookie', `ds_refresh=${stillLive.split('=')[1]!}`).expect(200);
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', stillLive).expect(200);
    });
  });

  // --- the frontend's signed-out marker ---------------------------------------------------

  describe('the signed-out marker the frontend keeps', () => {
    const markers = (response: request.Response): string[] => setCookiesOf(response).filter((c) => /hd_signed_out=/.test(c));

    it('is expired by a successful sign-in: __Host-, Secure, Path=/, no Domain (and the unprefixed name too)', async () => {
      const callback = await signIn(owner);
      const host = markers(callback).find((c) => c.startsWith('__Host-hd_signed_out=;'))!;
      expect(host).toBeDefined();
      expect(host).toContain('Path=/;');
      expect(host).toMatch(/;\s*Secure/i);
      expect(host).not.toMatch(/Domain=/i);
      expect(host).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(markers(callback).some((c) => c.startsWith('hd_signed_out=;'))).toBe(true);
    });

    it('is left alone when the sign-in fails, and by a refresh', async () => {
      const started = await request(http).get('/api/auth/workeasy360/start').expect(302);
      const refused = await request(http)
        .get('/api/auth/callback/workeasy360?error=access_denied&state=x')
        .set('Cookie', pair(started, FLOW_COOKIE)!);
      expect(refused.headers['location']).toBe(`${FRONTEND}/login?sso_error=cancelled`);
      expect(markers(refused)).toEqual([]);

      const callback = await signIn(owner);
      const renewed = await request(http).post(apiPath('/auth/refresh')).set('Cookie', pair(callback, REFRESH_COOKIE)!).expect(200);
      expect(markers(renewed)).toEqual([]);
    });
  });

  // --- customers set a new password through the help center -------------------------------

  describe('the help center\'s password reset (SSO-only)', () => {
    let slug = '';
    let organizationId = '';
    let sent: { to: string; url: string }[] = [];
    let spy: jest.SpyInstance | undefined;

    beforeEach(async () => {
      await signIn(owner);
      const organization = await harness.prisma.organization.findFirstOrThrow();
      organizationId = organization.id;
      slug = (await harness.prisma.helpCenter.findFirstOrThrow({ where: { organizationId } })).slug;
      const { MailerService } = await import('../src/email/mailer.service');
      sent = [];
      spy = jest.spyOn(harness.app.get(MailerService), 'send').mockImplementation(async (_org, to, template) => {
        if ('url' in template && typeof template.url === 'string') sent.push({ to, url: template.url });
      });
    });

    afterEach(() => spy?.mockRestore());

    const register = (email = 'rhea@example.com') =>
      request(http).post(apiPath(`/portal/${slug}/auth/register`)).send({ firstName: 'Rhea', email, password: 'PortalPass123' }).expect(201);
    const resets = () => sent.filter((mail) => mail.url.includes('/reset-password'));
    const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

    async function tokenFor(userId: string, type: 'PASSWORD_RESET' | 'INVITE', raw: string) {
      const { TokenService } = await import('../src/auth/token.service');
      await harness.prisma.verificationToken.create({
        data: {
          userId,
          type,
          tokenHash: harness.app.get(TokenService).hashRefreshToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      return raw;
    }

    it('lets a customer complete a reset while password sign-in is off for agents', async () => {
      await register();
      await request(http).post(apiPath(`/portal/${slug}/auth/forgot-password`)).send({ email: 'rhea@example.com' }).expect(200);
      expect(resets()).toHaveLength(1);
      expect(resets()[0]!.url).toContain(`/help/${slug}/reset-password?token=`);

      const token = tokenOf(resets()[0]!.url);
      await request(http).post(apiPath(`/portal/${slug}/auth/reset-password`)).send({ token, password: 'Brand-New-Pass9' }).expect(200);

      await request(http).post(apiPath(`/portal/${slug}/auth/login`)).send({ email: 'rhea@example.com', password: 'PortalPass123' }).expect(401);
      await request(http).post(apiPath(`/portal/${slug}/auth/login`)).send({ email: 'rhea@example.com', password: 'Brand-New-Pass9' }).expect(200);
      // Single use.
      await request(http).post(apiPath(`/portal/${slug}/auth/reset-password`)).send({ token, password: 'Another-Pass-9x' }).expect(400);
    });

    it('does not un-gate the agent route', async () => {
      await register();
      await request(http).post(apiPath(`/portal/${slug}/auth/forgot-password`)).send({ email: 'rhea@example.com' }).expect(200);
      const refused = await request(http)
        .post(apiPath('/auth/reset-password'))
        .send({ token: tokenOf(resets()[0]!.url), password: 'Brand-New-Pass9' })
        .expect(403);
      expect(refused.body.error.code).toBe('PASSWORD_SIGN_IN_DISABLED');
    });

    it('refuses an agent\'s reset token through the portal route, and does not consume it', async () => {
      const agentUser = await harness.prisma.user.findFirstOrThrow({ where: { organizationId, type: 'AGENT' } });
      const raw = await tokenFor(agentUser.id, 'PASSWORD_RESET', 'agent-reset-token-0123456789');
      const refused = await request(http).post(apiPath(`/portal/${slug}/auth/reset-password`)).send({ token: raw, password: 'Brand-New-Pass9' }).expect(400);
      expect(refused.body.error.message).toMatch(/invalid or has expired/);
      const row = await harness.prisma.verificationToken.findFirstOrThrow({ where: { userId: agentUser.id } });
      expect(row.usedAt).toBeNull();
      expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: agentUser.id } })).passwordHash).toBeNull();
    });

    it('refuses an invitation token, and a customer token of another help center', async () => {
      const customer = await register();
      const customerId = (customer.body.data.user as { id: string }).id;
      const invite = await tokenFor(customerId, 'INVITE', 'invite-token-0123456789abcdef');
      await request(http).post(apiPath(`/portal/${slug}/auth/reset-password`)).send({ token: invite, password: 'Brand-New-Pass9' }).expect(400);

      // A second help center (another organization) with its own customer.
      await signIn({ ...owner, sub: 'sub-b', email: 'b@b.example', organizationId: ORG_B, organizationName: 'Beta Desk' });
      const otherOrg = await harness.prisma.organization.findFirstOrThrow({ where: { workeasy360OrganizationId: ORG_B } });
      const otherSlug = (await harness.prisma.helpCenter.findFirstOrThrow({ where: { organizationId: otherOrg.id } })).slug;
      const otherCustomer = await request(http)
        .post(apiPath(`/portal/${otherSlug}/auth/register`))
        .send({ firstName: 'Omar', email: 'omar@example.com', password: 'PortalPass123' })
        .expect(201);
      const foreign = await tokenFor((otherCustomer.body.data.user as { id: string }).id, 'PASSWORD_RESET', 'foreign-reset-0123456789abcd');
      await request(http).post(apiPath(`/portal/${slug}/auth/reset-password`)).send({ token: foreign, password: 'Brand-New-Pass9' }).expect(400);
      // ...but it works at its own help center.
      await request(http).post(apiPath(`/portal/${otherSlug}/auth/reset-password`)).send({ token: foreign, password: 'Brand-New-Pass9' }).expect(200);
    });

    it('sends no reset mail to an agent who uses a customer\'s address on the help center', async () => {
      await request(http).post(apiPath(`/portal/${slug}/auth/forgot-password`)).send({ email: 'owner@acme.example' }).expect(200);
      expect(sent).toHaveLength(0);
      expect(await harness.prisma.verificationToken.count()).toBe(0);
    });
  });

  // --- realtime ------------------------------------------------------------------------------

  describe('realtime for a password-era agent', () => {
    it('is refused with WORKEASY360_SIGN_IN_REQUIRED and disconnected', async () => {
      const { provisionSystemRoles } = await import('@digisoft/db');
      const { AuthService } = await import('../src/auth/auth.service');
      const org = await harness.prisma.organization.create({ data: { name: 'Old', slug: 'old-rt', workeasy360OrganizationId: ORG_A } });
      const roleIds = await provisionSystemRoles(harness.prisma, org.id);
      const user = await harness.prisma.user.create({
        data: {
          organizationId: org.id, email: 'rt@old.example', firstName: 'R', lastName: 'T', type: 'AGENT',
          roles: { create: { roleId: roleIds['SUPER_ADMIN']! } },
        },
      });
      const session = await harness.app.get(AuthService).createSession(user.id, org.id, { ip: null, userAgent: null });

      await harness.app.listen(0);
      const port = ((harness.app.getHttpServer() as Server).address() as AddressInfo).port;
      const { io } = await import('socket.io-client');
      const socket = io(`http://127.0.0.1:${port}/rt`, { auth: { token: session.accessToken }, transports: ['websocket'], reconnection: false, forceNew: true });
      const payload = await new Promise<{ code?: string }>((resolve, reject) => {
        socket.on('access.ended', resolve);
        setTimeout(() => reject(new Error('no access.ended')), 8000);
      });
      socket.close();
      expect(payload.code).toBe('WORKEASY360_SIGN_IN_REQUIRED');
    });
  });
});
