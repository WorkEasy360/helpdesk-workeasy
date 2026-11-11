import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { Harness } from './app.harness';
import {
  ALLOW,
  FakeWorkeasy360,
  type AuthorizeOptions,
  type Identity,
} from './support/fake-workeasy360';

/**
 * "Sign in with Workeasy360" end to end: the real application against real Postgres and
 * Redis, and a fake Workeasy360 (discovery, key set, token endpoint, entitlement API) that
 * lives in this process. The test plays the browser: start, sign in at the provider,
 * callback - carrying cookies like a browser would.
 *
 * The environment is set before the application module is first loaded (ConfigModule
 * validates it when the module is evaluated), hence the dynamic imports.
 */

const FRONTEND = 'http://localhost:3000';
const REDIRECT_URI = `${FRONTEND}/api/auth/callback/workeasy360`;
const START = '/api/auth/workeasy360/start';
const CALLBACK = '/api/auth/callback/workeasy360';
const LOGOUT = '/api/auth/workeasy360/logout';
const FLOW_COOKIE = 'ds_w360_flow';
const REFRESH_COOKIE = 'ds_refresh';

const ORG_A = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const ORG_B = '9a8c7d6e-5f4e-4d3c-8b2a-1a0b9c8d7e6f';

const owner: Identity = {
  sub: 'sub-owner',
  email: 'owner@acme.example',
  emailVerified: true,
  name: 'Olive Owner',
  organizationId: ORG_A,
  organizationName: 'Acme Support',
};
const agent: Identity = {
  sub: 'sub-agent',
  email: 'agent@acme.example',
  emailVerified: true,
  givenName: 'Ada',
  familyName: 'Agent',
  organizationId: ORG_A,
};

const apiPath = (path: string): string => `/api/v1${path}`;

describe('Sign in with Workeasy360 (e2e)', () => {
  let provider: FakeWorkeasy360;
  let harness: Harness;
  let http: Server;
  let helpers: typeof import('./app.harness');
  let entitlements: import('../src/workeasy360/entitlement.service').EntitlementService;
  let linkOrganization: typeof import('../src/workeasy360/link-organization').linkOrganization;
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  // --- helpers ------------------------------------------------------------------

  const setCookies = (response: request.Response): string[] =>
    (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookieHeaderFor = (response: request.Response, name: string): string | undefined =>
    setCookies(response).find((cookie) => cookie.startsWith(`${name}=`));
  /** `name=value`, as a browser would send it back. */
  const pair = (response: request.Response, name: string): string | undefined =>
    cookieHeaderFor(response, name)?.split(';')[0];
  const isCleared = (header: string | undefined): boolean => !!header && /Expires=Thu, 01 Jan 1970/i.test(header);

  const decode = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

  interface SignInOptions {
    query?: Record<string, string | string[]>;
    authorize?: AuthorizeOptions;
    cookies?: string[];
    /** Overrides what is sent back to the callback. */
    callbackQuery?: (original: URLSearchParams) => URLSearchParams | string;
    /** Use another flow's cookie. */
    flowCookie?: string | null;
  }

  interface SignInResult {
    started: request.Response;
    flowCookie: string | undefined;
    callback: request.Response;
    landing: string;
    refreshCookie: string | undefined;
    code: string | undefined;
    state: string;
  }

  async function startFlow(query: Record<string, string | string[]> = {}, cookies: string[] = []) {
    const req = request(http).get(START).query(query);
    if (cookies.length > 0) req.set('Cookie', cookies.join('; '));
    return req;
  }

  /** The whole browser trip: start, sign in at Workeasy360, come back to the callback. */
  async function signIn(identity: Identity, options: SignInOptions = {}): Promise<SignInResult> {
    const started = await startFlow(options.query, options.cookies);
    expect(started.status).toBe(302);
    const flowCookie = pair(started, FLOW_COOKIE);
    const authorization = provider.authorize(started.headers['location'] as string, identity, options.authorize);

    let callbackUrl: URL;
    let code: string | undefined;
    if (authorization.ok) {
      code = authorization.code;
      callbackUrl = new URL(authorization.callbackUrl);
    } else if (authorization.callbackUrl) {
      callbackUrl = new URL(authorization.callbackUrl);
    } else {
      throw new Error(`the provider would not redirect back (${authorization.error})`);
    }
    const original = callbackUrl.searchParams;
    const state = original.get('state') ?? '';
    const search = options.callbackQuery ? options.callbackQuery(original) : original;
    const query = typeof search === 'string' ? search : search.toString();

    const cookies = [
      ...(options.flowCookie === null ? [] : [options.flowCookie ?? flowCookie]),
      ...(options.cookies ?? []),
    ].filter((c): c is string => Boolean(c));
    const req = request(http).get(`${CALLBACK}${query ? `?${query}` : ''}`);
    if (cookies.length > 0) req.set('Cookie', cookies.join('; '));
    const callback = await req;
    return {
      started,
      flowCookie,
      callback,
      landing: callback.headers['location'] as string,
      refreshCookie: pair(callback, REFRESH_COOKIE),
      code,
      state,
    };
  }

  const loginError = (code: string): string => `${FRONTEND}/login?sso_error=${code}`;

  async function expectRefused(result: SignInResult, code: string): Promise<void> {
    expect(result.callback.status).toBe(302);
    expect(result.landing).toBe(loginError(code));
    // No session: no refresh cookie is issued, and the single-use flow cookie is dropped.
    expect(cookieHeaderFor(result.callback, REFRESH_COOKIE)?.startsWith(`${REFRESH_COOKIE}=;`) ?? true).toBe(true);
    expect(isCleared(cookieHeaderFor(result.callback, FLOW_COOKIE))).toBe(true);
    expect(result.callback.headers['cache-control']).toBe('no-store');
  }

  const sessions = (): Promise<number> => harness.prisma.refreshToken.count();

  async function refresh(cookie: string): Promise<{ response: request.Response; token: string; cookie: string }> {
    const response = await request(http).post(apiPath('/auth/refresh')).set('Cookie', cookie).expect(200);
    return {
      response,
      token: response.body.data.accessToken as string,
      cookie: pair(response, REFRESH_COOKIE)!,
    };
  }

  /** Signs in and returns a bearer for the new session. */
  async function session(identity: Identity, options: SignInOptions = {}) {
    const result = await signIn(identity, options);
    expect(result.callback.status).toBe(302);
    expect(result.refreshCookie).toBeDefined();
    const renewed = await refresh(result.refreshCookie!);
    return { result, bearer: { Authorization: `Bearer ${renewed.token}` }, cookie: renewed.cookie, token: renewed.token };
  }

  /** Forgets what the application remembers of Workeasy360's answers: "the window has passed". */
  async function windowPasses(): Promise<void> {
    const keys = [...(await harness.redis.keys('w360:ent:*')), ...(await harness.redis.keys('org:*:w360'))];
    if (keys.length > 0) await harness.redis.del(...keys);
    entitlements.clearLocal();
  }

  // --- lifecycle -----------------------------------------------------------------

  beforeAll(async () => {
    provider = await FakeWorkeasy360.start({ redirectUri: REDIRECT_URI, appPublicKey: appKeys.publicKey });
    Object.assign(process.env, {
      WORKEASY360_ISSUER: provider.issuer,
      WORKEASY360_CLIENT_ID: provider.clientId,
      WORKEASY360_REDIRECT_URI: REDIRECT_URI,
      WORKEASY360_KEY_ID: provider.keyId,
      // Inline with literal backslash-n sequences, as it arrives in a one-line variable.
      WORKEASY360_PRIVATE_KEY: appKeys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString()
        .trim()
        .split('\n')
        .join(String.fromCharCode(92) + 'n'),
      WORKEASY360_POST_LOGOUT_REDIRECT_URI: `${FRONTEND}/login`,
      WORKEASY360_SSO_ONLY: 'false',
      REALTIME_ACCESS_RECHECK_SECONDS: '1',
    });
    helpers = await import('./app.harness');
    harness = await helpers.createHarness();
    http = harness.app.getHttpServer() as Server;
    const { EntitlementService } = await import('../src/workeasy360/entitlement.service');
    entitlements = harness.app.get(EntitlementService);
    ({ linkOrganization } = await import('../src/workeasy360/link-organization'));
  }, 240_000);

  beforeEach(async () => {
    await helpers.resetDatabase(harness.prisma, harness.redis);
    provider.reset();
    entitlements.clearLocal();
  });

  afterAll(async () => {
    await harness?.close();
    await provider?.stop();
  });

  // --- start ----------------------------------------------------------------------

  describe('start', () => {
    it('redirects to the discovered authorization endpoint with state, nonce, PKCE S256 and the configured redirect URI', async () => {
      const response = await startFlow();
      expect(response.status).toBe(302);
      expect(response.headers['cache-control']).toBe('no-store');
      const location = new URL(response.headers['location'] as string);
      expect(`${location.origin}${location.pathname}`).toBe(`${provider.issuer}/authorize`);
      const params = location.searchParams;
      expect(params.get('response_type')).toBe('code');
      expect(params.get('client_id')).toBe(provider.clientId);
      expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(params.get('scope')).toBe('openid email profile organization');
      expect(params.get('code_challenge_method')).toBe('S256');
      expect(params.get('state')!.length).toBeGreaterThanOrEqual(43);
      expect(params.get('nonce')!.length).toBeGreaterThanOrEqual(43);
      expect(params.get('code_challenge')!.length).toBeGreaterThanOrEqual(43);
      expect(params.has('organization')).toBe(false);
      expect(params.has('next')).toBe(false);
    });

    it('keeps the flow in an httpOnly, SameSite=Lax cookie scoped to the callback, for ten minutes', async () => {
      const response = await startFlow();
      const cookie = cookieHeaderFor(response, FLOW_COOKIE)!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toContain('Path=/api/auth/callback');
      expect(cookie).toContain('Max-Age=600');
      // The browser holds an id, never the state, nonce or verifier.
      const state = new URL(response.headers['location'] as string).searchParams.get('state')!;
      expect(cookie).not.toContain(state);
    });

    it('keeps state, nonce and verifier server-side, in Redis, under a hash of the cookie, with a ten minute TTL', async () => {
      const response = await startFlow();
      const flowId = pair(response, FLOW_COOKIE)!.split('=')[1]!;
      const key = `w360:flow:${createHash('sha256').update(flowId).digest('hex')}`;
      const raw = await harness.redis.get(key);
      expect(raw).not.toBeNull();
      const flow = JSON.parse(raw!) as Record<string, string>;
      const params = new URL(response.headers['location'] as string).searchParams;
      expect(flow['state']).toBe(params.get('state'));
      expect(flow['nonce']).toBe(params.get('nonce'));
      expect(createHash('sha256').update(flow['verifier']!).digest('base64url')).toBe(params.get('code_challenge'));
      const ttl = await harness.redis.ttl(key);
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
      expect(await harness.redis.get(`w360:flow:${flowId}`)).toBeNull();
    });

    it('generates fresh secrets for every start', async () => {
      const a = await startFlow();
      const b = await startFlow();
      const pa = new URL(a.headers['location'] as string).searchParams;
      const pb = new URL(b.headers['location'] as string).searchParams;
      expect(pa.get('state')).not.toBe(pb.get('state'));
      expect(pa.get('nonce')).not.toBe(pb.get('nonce'));
      expect(pa.get('code_challenge')).not.toBe(pb.get('code_challenge'));
      expect(pair(a, FLOW_COOKIE)).not.toBe(pair(b, FLOW_COOKIE));
    });

    it('forwards the launcher organization only when it is a UUID', async () => {
      const good = await startFlow({ organization: ORG_A.toUpperCase() });
      expect(new URL(good.headers['location'] as string).searchParams.get('organization')).toBe(ORG_A);
      for (const bad of ['not-a-uuid', 'x'.repeat(500), `${ORG_A}'; drop table`, '']) {
        const response = await startFlow({ organization: bad });
        expect(new URL(response.headers['location'] as string).searchParams.has('organization')).toBe(false);
      }
      const array = await startFlow({ organization: [ORG_A, ORG_B] });
      expect(new URL(array.headers['location'] as string).searchParams.has('organization')).toBe(false);
    });

    it('does not start a session or touch the database', async () => {
      await startFlow({ organization: ORG_A });
      expect(await sessions()).toBe(0);
      expect(await harness.prisma.organization.count()).toBe(0);
    });
  });

  // --- a new organization ---------------------------------------------------------

  describe('the first sign-in of a new organization', () => {
    it('creates the organization like registration does, with the person as SUPER_ADMIN, and lands on the dashboard', async () => {
      const result = await signIn(owner);
      expect(result.landing).toBe(`${FRONTEND}/dashboard`);

      const organization = await harness.prisma.organization.findFirstOrThrow({
        include: { helpCenter: true, businessHours: true, departments: true, roles: true, ticketStatuses: true, slaPolicies: true },
      });
      expect(organization.workeasy360OrganizationId).toBe(ORG_A);
      expect(organization.name).toBe('Acme Support');
      expect(organization.slug).toBe('acme-support');
      expect(organization.helpCenter?.slug).toBe('acme-support');
      expect(organization.businessHours.length).toBeGreaterThan(0);
      expect(organization.departments.map((d) => d.name)).toContain('General');
      expect(organization.roles.map((r) => r.systemKey).sort()).toEqual(
        ['ADMIN', 'AGENT', 'CUSTOMER', 'LIGHT_AGENT', 'SUPER_ADMIN'],
      );
      expect(organization.ticketStatuses.length).toBeGreaterThan(0);

      const user = await harness.prisma.user.findFirstOrThrow({
        include: { roles: { include: { role: true } }, externalIdentities: true },
      });
      expect(user.email).toBe('owner@acme.example');
      expect(user.type).toBe('AGENT');
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.firstName).toBe('Olive');
      expect(user.lastName).toBe('Owner');
      expect(user.roles.map((r) => r.role.systemKey)).toEqual(['SUPER_ADMIN']);
      expect(user.externalIdentities).toHaveLength(1);
      expect(user.externalIdentities[0]).toMatchObject({
        issuer: provider.issuer,
        subject: 'sub-owner',
        organizationId: organization.id,
        email: 'owner@acme.example',
      });
    });

    it('issues a session the existing bootstrap understands: a refresh cookie scoped to /api, then an access token with the Workeasy360 claims', async () => {
      const result = await signIn(owner);
      const header = cookieHeaderFor(result.callback, REFRESH_COOKIE)!;
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(header).toContain('Path=/api;');
      // The cookie of the previous release is expired alongside, so a browser never holds two.
      const legacy = setCookies(result.callback).find((c) => c.startsWith(`${REFRESH_COOKIE}=;`) && c.includes('Path=/api/v1/auth'));
      expect(legacy).toBeDefined();
      expect(isCleared(cookieHeaderFor(result.callback, FLOW_COOKIE))).toBe(true);

      const renewed = await refresh(result.refreshCookie!);
      const claims = decode(renewed.token);
      expect(claims['typ']).toBe('AGENT');
      expect(claims['w360']).toEqual({ org: ORG_A, sub: 'sub-owner' });

      const me = await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${renewed.token}`).expect(200);
      expect(me.body.data).toMatchObject({ email: 'owner@acme.example', type: 'AGENT', roles: ['SUPER_ADMIN'] });
      expect(me.body.data.permissions).toContain('organization.update');

      // The claims survive rotation.
      const again = await refresh(renewed.cookie);
      expect(decode(again.token)['w360']).toEqual({ org: ORG_A, sub: 'sub-owner' });
    });

    it('names the organization "My organization" when the token carries no name', async () => {
      await signIn({ ...owner, organizationName: undefined });
      const organization = await harness.prisma.organization.findFirstOrThrow();
      expect(organization.name).toBe('My organization');
      expect(organization.slug).toBe('my-organization');
    });

    it('finds a free address when the slug is taken, including by a help center', async () => {
      await helpers.registerOrg(http, 'acme-support');
      await signIn(owner);
      const organization = await harness.prisma.organization.findFirstOrThrow({ where: { workeasy360OrganizationId: ORG_A } });
      expect(organization.slug).toBe('acme-support-2');
    });

    it('creates one organization when two people from it sign in at the same moment', async () => {
      const [first, second] = await Promise.all([signIn(owner), signIn(agent)]);
      expect(first.refreshCookie).toBeDefined();
      expect(second.refreshCookie).toBeDefined();
      expect(await harness.prisma.organization.count()).toBe(1);
      expect(await harness.prisma.user.count()).toBe(2);
      expect(await harness.prisma.externalIdentity.count()).toBe(2);
      const roles = await harness.prisma.userRole.findMany({ include: { role: true } });
      // Exactly one of them created the organization and owns it.
      expect(roles.filter((r) => r.role.systemKey === 'SUPER_ADMIN')).toHaveLength(1);
      expect(roles.filter((r) => r.role.systemKey === 'AGENT')).toHaveLength(1);
    });

    it('creates a separate organization for each Workeasy360 organization', async () => {
      await signIn(owner);
      await signIn({ ...owner, organizationId: ORG_B, organizationName: 'Beta Desk' });
      expect(await harness.prisma.organization.count()).toBe(2);
    });
  });

  // --- joining an existing organization -------------------------------------------

  describe('joining an organization that already exists', () => {
    it('creates an AGENT with the default role and no password, never a SUPER_ADMIN', async () => {
      await signIn(owner);
      const result = await signIn(agent);
      expect(result.refreshCookie).toBeDefined();
      const user = await harness.prisma.user.findFirstOrThrow({
        where: { email: 'agent@acme.example' },
        include: { roles: { include: { role: true } }, externalIdentities: true },
      });
      expect(user.type).toBe('AGENT');
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.firstName).toBe('Ada');
      expect(user.lastName).toBe('Agent');
      expect(user.roles.map((r) => r.role.systemKey)).toEqual(['AGENT']);
      expect(user.externalIdentities).toHaveLength(1);
      expect(await harness.prisma.organization.count()).toBe(1);
    });

    it('lets the same Workeasy360 account back in as the same person, whatever its address became', async () => {
      await signIn(owner);
      await signIn({ ...owner, email: 'olive.new@acme.example' });
      expect(await harness.prisma.user.count()).toBe(1);
      const identity = await harness.prisma.externalIdentity.findFirstOrThrow();
      expect(identity.email).toBe('olive.new@acme.example');
      const user = await harness.prisma.user.findFirstOrThrow();
      expect(user.email).toBe('owner@acme.example');
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('is two people in two organizations when one Workeasy360 account belongs to both', async () => {
      await signIn(owner);
      await signIn({ ...owner, organizationId: ORG_B, organizationName: 'Beta Desk' });
      const users = await harness.prisma.user.findMany({ include: { externalIdentities: true } });
      expect(users).toHaveLength(2);
      expect(new Set(users.map((u) => u.organizationId)).size).toBe(2);
      for (const user of users) {
        expect(user.externalIdentities).toHaveLength(1);
        expect(user.externalIdentities[0]!.subject).toBe('sub-owner');
        expect(user.externalIdentities[0]!.organizationId).toBe(user.organizationId);
      }
    });
  });

  // --- linking an existing local account ---------------------------------------------

  describe('linking an account that already exists locally', () => {
    async function legacyOrganization() {
      const legacy = await helpers.registerOrg(http, 'legacy', 'owner@acme.example');
      await linkOrganization(harness.prisma, legacy.organizationId, ORG_A);
      return legacy;
    }

    it('lands in the linked organization, links by a verified address, retires the password and revokes its sessions', async () => {
      const legacy = await legacyOrganization();
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'owner@acme.example', password: 'Str0ngPassword1' })
        .expect(200);
      const oldCookie = pair(login, REFRESH_COOKIE)!;

      const result = await signIn(owner);
      expect(result.refreshCookie).toBeDefined();
      expect(await harness.prisma.organization.count()).toBe(1);

      const user = await harness.prisma.user.findUniqueOrThrow({
        where: { id: legacy.userId },
        include: { roles: { include: { role: true } }, externalIdentities: true },
      });
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.roles.map((r) => r.role.systemKey)).toEqual(['SUPER_ADMIN']);
      expect(user.externalIdentities).toHaveLength(1);
      expect(await harness.prisma.user.count()).toBe(1);

      // Every session the old password issued is gone.
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', oldCookie).expect(401);
      // And the password no longer opens anything.
      await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'owner@acme.example', password: 'Str0ngPassword1' })
        .expect(401);
    });

    it('does not link an address Workeasy360 has not verified, and creates nothing', async () => {
      const legacy = await legacyOrganization();
      const before = await sessions();
      const result = await signIn({ ...owner, emailVerified: false });
      await expectRefused(result, 'email_unverified');
      expect(await sessions()).toBe(before);
      const user = await harness.prisma.user.findUniqueOrThrow({ where: { id: legacy.userId } });
      expect(user.passwordHash).not.toBeNull();
      expect(await harness.prisma.externalIdentity.count()).toBe(0);
    });

    it('does not create an account for an unverified address either', async () => {
      await signIn(owner);
      const result = await signIn({ ...agent, emailVerified: false });
      await expectRefused(result, 'email_unverified');
      expect(await harness.prisma.user.count()).toBe(1);
    });

    it('refuses a token without an email', async () => {
      await signIn(owner);
      const result = await signIn({ ...agent, email: undefined });
      await expectRefused(result, 'email_missing');
    });

    it('refuses to turn a customer of the help center into an agent (account_conflict)', async () => {
      await signIn(owner);
      const organization = await harness.prisma.organization.findFirstOrThrow();
      await harness.prisma.user.create({
        data: {
          organizationId: organization.id,
          email: 'agent@acme.example',
          firstName: 'Cora',
          lastName: 'Customer',
          type: 'CUSTOMER',
          passwordHash: 'x',
        },
      });
      const result = await signIn(agent);
      await expectRefused(result, 'account_conflict');
      expect(await harness.prisma.externalIdentity.count()).toBe(1);
    });

    it('refuses an account already linked to another Workeasy360 account (account_conflict)', async () => {
      await signIn(owner);
      const result = await signIn({ ...owner, sub: 'sub-impostor' });
      await expectRefused(result, 'account_conflict');
      const identities = await harness.prisma.externalIdentity.findMany();
      expect(identities.map((i) => i.subject)).toEqual(['sub-owner']);
    });

    it('refuses a deactivated account, found by identity or by address (account_disabled)', async () => {
      await signIn(owner);
      await signIn(agent);
      await harness.prisma.user.updateMany({ where: { email: 'agent@acme.example' }, data: { isActive: false } });
      await expectRefused(await signIn(agent), 'account_disabled');

      // By address: a pre-provisioned but deactivated agent.
      const organization = await harness.prisma.organization.findFirstOrThrow();
      await harness.prisma.user.create({
        data: { organizationId: organization.id, email: 'new@acme.example', firstName: 'N', lastName: 'N', type: 'AGENT', isActive: false },
      });
      await expectRefused(await signIn({ ...agent, sub: 'sub-new', email: 'new@acme.example' }), 'account_disabled');
    });

    it('refuses a deleted account (account_disabled) and a deleted organization (organization_inactive)', async () => {
      await signIn(owner);
      await signIn(agent);
      await harness.prisma.user.updateMany({ where: { email: 'agent@acme.example' }, data: { deletedAt: new Date() } });
      await expectRefused(await signIn(agent), 'account_disabled');

      await harness.prisma.organization.updateMany({ data: { deletedAt: new Date() } });
      await expectRefused(await signIn(owner), 'organization_inactive');
    });

    it('lets an administrator pre-provision an agent who then signs in and is linked by verified address', async () => {
      await signIn(owner);
      const organization = await harness.prisma.organization.findFirstOrThrow();
      const role = await harness.prisma.role.findFirstOrThrow({ where: { organizationId: organization.id, systemKey: 'LIGHT_AGENT' } });
      const pre = await harness.prisma.user.create({
        data: {
          organizationId: organization.id,
          email: 'agent@acme.example',
          firstName: 'Ada',
          lastName: 'Agent',
          type: 'AGENT',
          roles: { create: { roleId: role.id } },
        },
      });
      await signIn(agent);
      const linked = await harness.prisma.user.findUniqueOrThrow({
        where: { id: pre.id },
        include: { roles: { include: { role: true } }, externalIdentities: true },
      });
      expect(linked.externalIdentities).toHaveLength(1);
      // Their role is the one the administrator gave, not the default.
      expect(linked.roles.map((r) => r.role.systemKey)).toEqual(['LIGHT_AGENT']);
    });
  });

  // --- the link command -------------------------------------------------------------

  describe('link-workeasy360-organization', () => {
    it('attaches an existing organization so its first sign-in lands in it rather than in a new one', async () => {
      const legacy = await helpers.registerOrg(http, 'legacy', 'owner@acme.example');
      const result = await linkOrganization(harness.prisma, legacy.organizationId, ORG_A.toUpperCase());
      expect(result.changed).toBe(true);
      await signIn(owner);
      expect(await harness.prisma.organization.count()).toBe(1);
      const organization = await harness.prisma.organization.findUniqueOrThrow({ where: { id: legacy.organizationId } });
      expect(organization.workeasy360OrganizationId).toBe(ORG_A);
    });

    it('refuses to attach a Workeasy360 organization that another organization already holds', async () => {
      await signIn(owner);
      const other = await helpers.registerOrg(http, 'other');
      await expect(linkOrganization(harness.prisma, other.organizationId, ORG_A)).rejects.toThrow(/already linked/);
    });
  });

  // --- the callback's own integrity ---------------------------------------------------

  describe('callback integrity (every failure is a redirect to the sign-in page, with no session)', () => {
    it('refuses a wrong state', async () => {
      const result = await signIn(owner, {
        callbackQuery: (q) => {
          q.set('state', 'a-different-state-value');
          return q;
        },
      });
      await expectRefused(result, 'expired');
      expect(await sessions()).toBe(0);
      expect(await harness.prisma.organization.count()).toBe(0);
      // It did not even reach the token endpoint.
      expect(provider.tokenRequests).toHaveLength(0);
    });

    it('refuses a missing state', async () => {
      const result = await signIn(owner, {
        callbackQuery: (q) => {
          q.delete('state');
          return q;
        },
      });
      await expectRefused(result, 'expired');
      expect(provider.tokenRequests).toHaveLength(0);
    });

    it('refuses a callback from a browser that never started the flow (no cookie)', async () => {
      const result = await signIn(owner, { flowCookie: null });
      await expectRefused(result, 'expired');
      expect(provider.tokenRequests).toHaveLength(0);
    });

    it('refuses a forged or unknown flow cookie', async () => {
      for (const flowCookie of [`${FLOW_COOKIE}=garbage`, `${FLOW_COOKIE}=${'A'.repeat(43)}`, `${FLOW_COOKIE}=`]) {
        await expectRefused(await signIn(owner, { flowCookie }), 'expired');
      }
    });

    it('binds the state to the browser that started the flow: another flow cookie does not help', async () => {
      const other = await startFlow();
      const result = await signIn(owner, { flowCookie: pair(other, FLOW_COOKIE) });
      await expectRefused(result, 'expired');
      // The other browser's flow was not consumed by this stranger... but it was not used either.
      expect(provider.tokenRequests).toHaveLength(0);
    });

    it('consumes the flow on the first callback: a second one with the same cookie and state is expired', async () => {
      const first = await signIn(owner);
      expect(first.refreshCookie).toBeDefined();
      const replay = await request(http)
        .get(`${CALLBACK}?code=${first.code}&state=${first.state}`)
        .set('Cookie', first.flowCookie!);
      expect(replay.headers['location']).toBe(loginError('expired'));
      expect(setCookies(replay).some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && !c.startsWith(`${REFRESH_COOKIE}=;`))).toBe(false);
    });

    it('consumes the flow even when the callback fails', async () => {
      const started = await startFlow();
      const flowCookie = pair(started, FLOW_COOKIE)!;
      const authorization = provider.authorize(started.headers['location'] as string, owner);
      if (!authorization.ok) throw new Error('unexpected');
      const wrong = await request(http).get(`${CALLBACK}?code=${authorization.code}&state=wrong`).set('Cookie', flowCookie);
      expect(wrong.headers['location']).toBe(loginError('expired'));
      // The right state now arrives too late.
      const right = await request(http)
        .get(`${CALLBACK}?code=${authorization.code}&state=${authorization.state}`)
        .set('Cookie', flowCookie);
      expect(right.headers['location']).toBe(loginError('expired'));
    });

    it('refuses a flow that outlived its ten minutes', async () => {
      const started = await startFlow();
      const flowId = pair(started, FLOW_COOKIE)!.split('=')[1]!;
      const key = `w360:flow:${createHash('sha256').update(flowId).digest('hex')}`;
      const raw = JSON.parse((await harness.redis.get(key))!) as Record<string, unknown>;
      raw['at'] = Date.now() - 601_000;
      await harness.redis.set(key, JSON.stringify(raw), 'EX', 60);
      const authorization = provider.authorize(started.headers['location'] as string, owner);
      if (!authorization.ok) throw new Error('unexpected');
      const response = await request(http)
        .get(`${CALLBACK}?code=${authorization.code}&state=${authorization.state}`)
        .set('Cookie', pair(started, FLOW_COOKIE)!);
      expect(response.headers['location']).toBe(loginError('expired'));
    });

    it('refuses a callback without a code', async () => {
      const result = await signIn(owner, {
        callbackQuery: (q) => {
          q.delete('code');
          return q;
        },
      });
      await expectRefused(result, 'refused');
    });

    it('refuses an absurdly long code or state without choking', async () => {
      await expectRefused(
        await signIn(owner, { callbackQuery: (q) => { q.set('code', 'c'.repeat(5000)); return q; } }),
        'refused',
      );
      await expectRefused(
        await signIn(owner, { callbackQuery: (q) => { q.set('state', 's'.repeat(5000)); return q; } }),
        'expired',
      );
    });

    it.each([
      ['access_denied', 'cancelled'],
      ['login_required', 'expired'],
      ['organization_required', 'expired'],
      ['product_not_entitled', 'not_entitled'],
      ['product_no_seat', 'no_seat'],
      ['membership_inactive', 'provider_membership_inactive'],
      ['organization_inactive', 'organization_inactive'],
      ['access_policy_denied', 'access_policy'],
      ['integration_suspended', 'unavailable'],
      ['unauthorized_client', 'unavailable'],
      ['interaction_required', 'expired'],
      ['server_error', 'unavailable'],
      ['something_nobody_has_seen', 'refused'],
    ])('maps the provider error %s to %s', async (error, code) => {
      const result = await signIn(owner, {
        callbackQuery: (q) => {
          q.delete('code');
          q.set('error', error);
          return q;
        },
      });
      await expectRefused(result, code);
      expect(provider.tokenRequests).toHaveLength(0);
    });

    it('lands on the sign-in page, not an error page, when the provider says the person is not a member', async () => {
      // Launcher names organization A; the person is only in B.
      const result = await signIn({ ...owner, organizationId: ORG_B }, { query: { organization: ORG_A } });
      await expectRefused(result, 'provider_membership_inactive');
    });
  });

  // --- the ID token ---------------------------------------------------------------------

  describe('ID token verification at the callback', () => {
    it.each([
      ['a wrong audience (a token minted for another client)', { aud: 'another-products-client-id' }, 'refused'],
      ['an audience list that does not contain this client', { aud: ['a', 'b'] }, 'refused'],
      ['a wrong issuer', { iss: 'https://evil.example' }, 'refused'],
      ['an expired token', { expOffset: -3600, iatOffset: -3900 }, 'refused'],
      ['a token issued in the future', { iatOffset: 3600, expOffset: 4000 }, 'refused'],
      ['a wrong typ (an access token)', { typ: 'access_token' }, 'refused'],
      ['no typ', { omit: ['typ'] }, 'refused'],
      ['no jti', { omit: ['jti'] }, 'refused'],
      ['no sub', { omit: ['sub'] }, 'refused'],
      ['no exp', { omit: ['exp'] }, 'refused'],
      ['no iat', { omit: ['iat'] }, 'refused'],
      ['a wrong nonce', { nonce: 'a-nonce-from-someone-elses-flow' }, 'refused'],
      ['no nonce', { omit: ['nonce'] }, 'refused'],
      ['no organization_id', { omit: ['organization_id'] }, 'refused'],
      ['an organization_id that is not a UUID', { extra: { organization_id: 'acme' } }, 'refused'],
      ['alg none', { alg: 'none' as const }, 'refused'],
      ['HS256 signed with the public key as the secret', { alg: 'HS256' as const }, 'refused'],
      ['a key that is not in the key set', { unknownKey: true }, 'refused'],
      ['a wrong product code', { productCode: 'easy_crm' }, 'wrong_product'],
      ['no product code', { omit: ['product_code'] }, 'wrong_product'],
    ])('refuses %s', async (_name, tweak, code) => {
      const result = await signIn(owner, { authorize: { tweak } });
      await expectRefused(result, code);
      expect(await sessions()).toBe(0);
      expect(await harness.prisma.organization.count()).toBe(0);
      expect(await harness.prisma.user.count()).toBe(0);
    });

    it('refuses a token minted for another product\'s client (cross-product): audience and product both wrong', async () => {
      const result = await signIn(owner, { authorize: { tweak: { aud: 'crm-client-id', productCode: 'easy_crm' } } });
      await expectRefused(result, 'refused');
      expect(await sessions()).toBe(0);
    });
  });

  // --- the code exchange ---------------------------------------------------------------

  describe('the code exchange', () => {
    it('authenticates with private_key_jwt, sends the registered redirect URI and the PKCE verifier', async () => {
      const result = await signIn(owner);
      expect(result.refreshCookie).toBeDefined();
      expect(provider.tokenRequests).toHaveLength(1);
      expect(provider.tokenRequests[0]).toMatchObject({
        redirectUri: REDIRECT_URI,
        assertionOk: true,
        pkceOk: true,
        outcome: 'issued',
      });
    });

    it('refuses when the code was bound to a different PKCE challenge', async () => {
      const result = await signIn(owner, { authorize: { tamperChallenge: true } });
      await expectRefused(result, 'refused');
      expect(provider.tokenRequests[0]).toMatchObject({ assertionOk: true, pkceOk: false, outcome: 'refused' });
    });

    it('refuses an expired code', async () => {
      const result = await signIn(owner, { authorize: { codeLifetimeSeconds: -5 } });
      await expectRefused(result, 'refused');
    });

    it('refuses a code that was already used', async () => {
      const first = await signIn(owner);
      expect(first.refreshCookie).toBeDefined();
      // A second flow, presented with the first flow's code.
      const started = await startFlow();
      const authorization = provider.authorize(started.headers['location'] as string, owner);
      if (!authorization.ok) throw new Error('unexpected');
      const response = await request(http)
        .get(`${CALLBACK}?code=${first.code}&state=${authorization.state}`)
        .set('Cookie', pair(started, FLOW_COOKIE)!);
      expect(response.headers['location']).toBe(loginError('refused'));
      expect(setCookies(response).filter((c) => c.startsWith(`${REFRESH_COOKIE}=`) && !c.startsWith(`${REFRESH_COOKIE}=;`))).toHaveLength(0);
    });

    it('is refused when the provider does not have the redirect URI registered (exact match)', async () => {
      provider.registeredRedirectUris = ['http://localhost:3000/api/auth/callback/workeasy360/'];
      const started = await startFlow();
      const url = new URL(started.headers['location'] as string);
      // What the application sent is exactly what it was configured with, trailing slash or not.
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      const authorization = provider.authorize(started.headers['location'] as string, owner);
      expect(authorization).toMatchObject({ ok: false, error: 'invalid_redirect_uri', callbackUrl: null });
    });

    it('rejects the exchange when only the token endpoint disagrees about the redirect URI', async () => {
      const started = await startFlow();
      const authorization = provider.authorize(started.headers['location'] as string, owner);
      if (!authorization.ok) throw new Error('unexpected');
      provider.registeredRedirectUris = ['https://elsewhere.example/callback'];
      const response = await request(http)
        .get(`${CALLBACK}?code=${authorization.code}&state=${authorization.state}`)
        .set('Cookie', pair(started, FLOW_COOKIE)!);
      expect(response.headers['location']).toBe(loginError('refused'));
    });

    it('treats a token endpoint outage as unavailable, with no session', async () => {
      provider.tokenEndpointFailure = 503;
      const result = await signIn(owner);
      await expectRefused(result, 'unavailable');
    });
  });

  // --- launching from Workeasy360 ---------------------------------------------------------

  describe('the launcher', () => {
    it('accepts a token for the organization the launcher named', async () => {
      const result = await signIn(owner, { query: { organization: ORG_A } });
      expect(result.refreshCookie).toBeDefined();
    });

    it('refuses a token for another organization than the launcher named (wrong_organization)', async () => {
      const result = await signIn(
        { ...owner, organizationId: ORG_B },
        { query: { organization: ORG_A }, authorize: { ignoreOrganizationHint: true } },
      );
      await expectRefused(result, 'wrong_organization');
      expect(await harness.prisma.organization.count()).toBe(0);
    });

    it('does not insist on an organization when the launcher named none', async () => {
      const result = await signIn({ ...owner, organizationId: ORG_B });
      expect(result.refreshCookie).toBeDefined();
    });
  });

  // --- where the person lands ------------------------------------------------------------

  describe('next', () => {
    it('lands on a same-site path, with its query', async () => {
      const result = await signIn(owner, { query: { next: '/tickets?status=open' } });
      expect(result.landing).toBe(`${FRONTEND}/tickets?status=open`);
    });

    it.each([
      ['a protocol-relative URL', '//evil.example'],
      ['an absolute URL', 'https://evil.example/'],
      ['a backslash', '/' + String.fromCharCode(92) + 'evil.example'],
      ['a tab', '/\t/evil.example'],
      ['the sign-in page', '/login'],
      ['the API', '/api/v1/tickets'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['an encoded double slash', '/%2F%2Fevil.example'],
    ])('does not follow %s', async (_name, next) => {
      const result = await signIn(owner, { query: { next } });
      expect(result.landing.startsWith(`${FRONTEND}/`)).toBe(true);
      expect(new URL(result.landing).origin).toBe(FRONTEND);
      expect(new URL(result.landing).pathname.startsWith('//')).toBe(false);
    });

    it('lands on the dashboard for an unusable next', async () => {
      for (const next of ['//evil.example', '/login', 'https://evil.example']) {
        await helpers.resetDatabase(harness.prisma, harness.redis);
        const result = await signIn(owner, { query: { next } });
        expect(result.landing).toBe(`${FRONTEND}/dashboard`);
      }
    });
  });

  // --- account switching and session fixation ---------------------------------------------

  describe('a session already in the browser', () => {
    it('ends the previous person\'s session on the server when a different person signs in', async () => {
      const first = await session(owner);
      await signIn(agent);
      // sign in as the agent while the browser still holds the owner's cookie:
      const switched = await signIn(agent, { cookies: [first.cookie] });
      expect(switched.refreshCookie).toBeDefined();

      // The previous session is gone, not merely overwritten in the cookie jar.
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', first.cookie).expect(401);
      const renewed = await refresh(switched.refreshCookie!);
      const me = await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${renewed.token}`).expect(200);
      expect(me.body.data.email).toBe('agent@acme.example');
    });

    it('never reuses a presented refresh token: a pre-set cookie for another user is revoked, and the new session has its own family', async () => {
      const victim = await session(owner);
      await signIn(agent);
      const presented = await harness.prisma.refreshToken.findFirstOrThrow({
        where: { user: { email: 'owner@acme.example' }, revokedAt: null },
      });

      const attack = await signIn(agent, { cookies: [victim.cookie] });
      expect(attack.refreshCookie).toBeDefined();
      expect(attack.refreshCookie).not.toBe(victim.cookie);

      const family = await harness.prisma.refreshToken.findMany({ where: { familyId: presented.familyId } });
      expect(family.every((t) => t.revokedAt !== null)).toBe(true);
      const issued = await harness.prisma.refreshToken.findFirstOrThrow({
        where: { user: { email: 'agent@acme.example' }, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(issued.familyId).not.toBe(presented.familyId);
    });

    it('ignores a cookie that is not one of ours', async () => {
      const result = await signIn(owner, { cookies: [`${REFRESH_COOKIE}=not-a-real-token`] });
      expect(result.refreshCookie).toBeDefined();
    });

    it('leaves the existing session alone when the new sign-in fails', async () => {
      const first = await session(owner);
      const failed = await signIn(agent, { cookies: [first.cookie], authorize: { tweak: { aud: 'other' } } });
      await expectRefused(failed, 'refused');
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', first.cookie).expect(200);
    });
  });

  // --- while the session lasts ------------------------------------------------------------

  describe('entitlement while a session lasts', () => {
    const ended = { decision: 'deny' as const, reason: 'expired' };

    it('asks Workeasy360 once per window per person, with the subject the session was signed in with', async () => {
      const owned = await session(owner);
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
      await request(http).get(apiPath('/departments')).set(owned.bearer).expect(200);
      const calls = provider.callsFor(ORG_A, 'sub-owner');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ assertionOk: true });
      // Nothing was asked about the organization alone for this request.
      expect(provider.callsFor(ORG_A, undefined)).toHaveLength(0);
    });

    it('asks again when the window has passed', async () => {
      const owned = await session(owner);
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
      expect(provider.callsFor(ORG_A, 'sub-owner')).toHaveLength(2);
    });

    it('cuts off a removed member within the window (membership_inactive), and only that member', async () => {
      const owned = await session(owner);
      const agented = await session(agent);
      await request(http).get(apiPath('/tickets')).set(agented.bearer).expect(200);

      provider.setPersonAnswer(ORG_A, 'sub-agent', { decision: 'deny', reason: 'membership_inactive' });
      await windowPasses();

      const refused = await request(http).get(apiPath('/tickets')).set(agented.bearer).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_ACCESS_ENDED');
      expect(refused.body.error.details).toEqual({ reason: 'membership_inactive' });
      await request(http).patch(apiPath('/auth/me')).set(agented.bearer).send({ firstName: 'X' }).expect(403);
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
    });

    it('lets a refused person see why and sign out: /auth/me, refresh, logout and the methods read stay available', async () => {
      const owned = await session(owner);
      provider.setOrganizationAnswer(ORG_A, ended);
      await windowPasses();

      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(403);
      await request(http).get(apiPath('/auth/me')).set(owned.bearer).expect(200);
      await request(http).get(apiPath('/auth/methods')).expect(200);
      const renewed = await refresh(owned.cookie);
      await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${renewed.token}`).expect(200);
      await request(http).get(apiPath('/health')).expect(200);
      await request(http).post(apiPath('/auth/logout')).set('Cookie', renewed.cookie).expect(200);
    });

    it.each([
      ['an expired entitlement', { decision: 'deny' as const, reason: 'expired' }],
      ['an expired trial', { decision: 'deny' as const, reason: 'expired' }],
      ['a suspended organization', { decision: 'deny' as const, reason: 'suspended' }],
      ['a product the organization never had', { decision: 'deny' as const, reason: 'not_entitled' }],
    ])('refuses everything for %s', async (_name, answer) => {
      const owned = await session(owner);
      provider.setOrganizationAnswer(ORG_A, answer);
      await windowPasses();
      for (const response of [
        await request(http).get(apiPath('/tickets')).set(owned.bearer),
        await request(http).patch(apiPath('/auth/me')).set(owned.bearer).send({ firstName: 'X' }),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('WORKEASY360_ACCESS_ENDED');
        expect(response.body.error.details.reason).toBe(answer.reason);
      }
    });

    it('takes effect again within a minute of a renewal', async () => {
      const owned = await session(owner);
      provider.setOrganizationAnswer(ORG_A, ended);
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(403);

      provider.setOrganizationAnswer(ORG_A, null);
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
    });

    it('allows reads but refuses writes while the organization is read-only', async () => {
      const owned = await session(owner);
      provider.setOrganizationAnswer(ORG_A, { decision: 'allow', reason: 'read_only', write_allowed: false });
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
      const refused = await request(http).patch(apiPath('/auth/me')).set(owned.bearer).send({ firstName: 'X' }).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_READ_ONLY');
      // A report export is a read: data portability while read-only.
      await request(http).post(apiPath('/reports/export')).set(owned.bearer).send({ kind: 'TICKETS', filters: {} }).expect(201);
    });

    it('is not an outage-denial: a failing entitlement API keeps the last answer, and with none lets access continue', async () => {
      provider.entitlementFailure = 503;
      const owned = await session(owner);
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);

      // Now with an answer on record...
      provider.entitlementFailure = null;
      provider.setOrganizationAnswer(ORG_A, ended);
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(403);
      // ...an outage does not hand access back, even once the answer is old enough to be re-asked.
      provider.entitlementFailure = 503;
      for (const key of await harness.redis.keys('w360:ent:sub:*')) {
        if (key.endsWith(':backoff') || key.endsWith(':refreshing')) {
          await harness.redis.del(key);
          continue;
        }
        const record = JSON.parse((await harness.redis.get(key))!) as Record<string, unknown>;
        record['at'] = Date.now() - 3600_000;
        await harness.redis.set(key, JSON.stringify(record));
      }
      entitlements.clearLocal();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(403);
      expect(provider.callsFor(ORG_A, 'sub-owner').length).toBeGreaterThanOrEqual(3);
    });

    it('fails closed with WORKEASY360_ACCESS_UNVERIFIED when Workeasy360 refuses our own client', async () => {
      const owned = await session(owner);
      provider.entitlementFailure = 403;
      await windowPasses();
      const refused = await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_ACCESS_UNVERIFIED');
      // ...and recovers once the credential is fixed.
      provider.entitlementFailure = null;
      await windowPasses();
      await request(http).get(apiPath('/tickets')).set(owned.bearer).expect(200);
    });

    it('never asks about an organization that is not bound to Workeasy360', async () => {
      const plain = await helpers.registerOrg(http, 'plain');
      await request(http).get(apiPath('/tickets')).set({ Authorization: `Bearer ${plain.token}` }).expect(200);
      expect(provider.entitlementCalls).toHaveLength(0);
    });

    it('serves an ended organization\'s help center to no one, and again after renewal', async () => {
      const owned = await session(owner);
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const slug = center.body.data.slug as string;
      await request(http).get(apiPath(`/portal/${slug}`)).expect(200);

      provider.setOrganizationAnswer(ORG_A, ended);
      await windowPasses();
      const refused = await request(http).get(apiPath(`/portal/${slug}`)).expect(403);
      expect(refused.body.error.code).toBe('HELP_CENTER_UNAVAILABLE');
      await request(http).get(apiPath(`/portal/${slug}/kb/categories`)).expect(403);
      await request(http)
        .post(apiPath(`/portal/${slug}/forms/contact-support/submit`))
        .send({ values: { name: 'N', email: 'n@example.com', subject: 's', description: 'd' } })
        .expect(403);

      provider.setOrganizationAnswer(ORG_A, null);
      await windowPasses();
      await request(http).get(apiPath(`/portal/${slug}`)).expect(200);
    });
  });

  // --- a customer's token on an agent route -----------------------------------------------

  describe('agent routes are for agents', () => {
    it('refuses a help center customer\'s token on an agent route that asks for no permission', async () => {
      const owned = await session(owner);
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const slug = center.body.data.slug as string;
      const customer = await request(http)
        .post(apiPath(`/portal/${slug}/auth/register`))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const bearer = { Authorization: `Bearer ${customer.body.data.accessToken as string}` };

      const me = await request(http).get(apiPath('/auth/me')).set(bearer).expect(403);
      expect(me.body.error.code).toBe('FORBIDDEN');
      await request(http).get(apiPath('/notifications')).set(bearer).expect(403);
      // The portal still serves them.
      await request(http).get(apiPath(`/portal/${slug}/tickets`)).set(bearer).expect(200);
    });
  });

  // --- signing out --------------------------------------------------------------------------

  describe('sign-out', () => {
    it('sends the browser to the discovered end_session_endpoint with the client id and the registered post-logout URI', async () => {
      const response = await request(http).get(LOGOUT);
      expect(response.status).toBe(302);
      const location = new URL(response.headers['location'] as string);
      expect(`${location.origin}${location.pathname}`).toBe(`${provider.issuer}/logout`);
      expect(location.searchParams.get('client_id')).toBe(provider.clientId);
      expect(location.searchParams.get('post_logout_redirect_uri')).toBe(`${FRONTEND}/login`);
    });

    it('changes nothing here: the local session is still valid afterwards', async () => {
      const owned = await session(owner);
      await request(http).get(LOGOUT).set('Cookie', owned.cookie).expect(302);
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', owned.cookie).expect(200);
    });
  });

  describe('methods', () => {
    it('offers both ways in when SSO is configured and not mandatory', async () => {
      const response = await request(http).get(apiPath('/auth/methods')).expect(200);
      expect(response.body.data).toEqual({ password: true, workeasy360: true, workeasy360SignOut: true });
    });
  });

  // --- password sign-in keeps working when SSO is optional ----------------------------------

  describe('the password cookie', () => {
    it('is scoped to /api now and expires the old /api/v1/auth path, so a browser never holds two', async () => {
      await helpers.registerOrg(http, 'cookies');
      const login = await request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'owner@cookies.example', password: 'Str0ngPassword1' })
        .expect(200);
      const headers = setCookies(login).filter((c) => c.startsWith(`${REFRESH_COOKIE}=`));
      expect(headers[0]).toContain('Path=/api;');
      expect(headers[0]).toMatch(/HttpOnly/i);
      expect(headers.some((c) => c.includes('Path=/api/v1/auth') && isCleared(c))).toBe(true);

      const out = await request(http).post(apiPath('/auth/logout')).set('Cookie', pair(login, REFRESH_COOKIE)!).expect(200);
      const cleared = setCookies(out).filter((c) => c.startsWith(`${REFRESH_COOKIE}=`));
      expect(cleared.every(isCleared)).toBe(true);
      expect(cleared.map((c) => /Path=([^;]+)/.exec(c)![1]).sort()).toEqual(['/api', '/api/v1/auth']);
    });
  });

  it('never logs a code, token, state or nonce', async () => {
    // The testing module silences Nest's logger, so listen at the source.
    const { Logger } = await import('@nestjs/common');
    const seen: unknown[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        seen.push(args);
      }),
    );
    let failed: SignInResult;
    let succeeded: SignInResult;
    try {
      failed = await signIn(owner, { authorize: { tweak: { aud: 'other' } } });
      succeeded = await signIn(owner);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const logged = JSON.stringify(seen);
    // Failures and successes are logged (so this proves the capture works) but only by code and id.
    expect(logged).toContain('workeasy360.sign_in_failed');
    expect(logged).toContain('workeasy360.sign_in');
    for (const result of [failed, succeeded]) {
      expect(result.code).toBeDefined();
      expect(logged).not.toContain(result.code!);
      expect(logged).not.toContain(result.state);
    }
    const flowId = failed.flowCookie!.split('=')[1]!;
    expect(logged).not.toContain(flowId);
    expect(logged).not.toContain(succeeded.refreshCookie!.split('=')[1]!);
  });


  // --- the realtime socket ---------------------------------------------------------------------

  describe('realtime (/rt)', () => {
    let wsUrl = '';
    const open: { close: () => void }[] = [];

    beforeAll(async () => {
      await harness.app.listen(0);
      wsUrl = `http://127.0.0.1:${((harness.app.getHttpServer() as Server).address() as AddressInfo).port}`;
    });

    afterEach(() => {
      for (const socket of open.splice(0)) socket.close();
    });

    async function connect(token: string) {
      const { io } = await import('socket.io-client');
      const socket = io(`${wsUrl}/rt`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
      open.push(socket);
      const events: { name: string; payload: unknown }[] = [];
      socket.onAny((name: string, payload: unknown) => events.push({ name, payload }));
      const disconnected = new Promise<string>((resolve) => socket.on('disconnect', resolve));
      const connected = new Promise<void>((resolve) => socket.on('connect', resolve));
      const ended = (): Promise<{ code?: string; reason?: string }> =>
        new Promise((resolve, reject) => {
          const found = events.find((e) => e.name === 'access.ended');
          if (found) return resolve(found.payload as { code?: string; reason?: string });
          socket.on('access.ended', resolve);
          setTimeout(() => reject(new Error('the socket was never told access ended')), 8000);
        });
      return { socket, events, disconnected, connected, ended };
    }

    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('keeps an entitled agent connected across several re-checks', async () => {
      const owned = await session(owner);
      const live = await connect(owned.token);
      await live.connected;
      await settle(3200);
      expect(live.socket.connected).toBe(true);
      expect(live.events.some((e) => e.name === 'access.ended')).toBe(false);
    });

    it('refuses a help center customer\'s token on the agent channel', async () => {
      const owned = await session(owner);
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const customer = await request(http)
        .post(apiPath(`/portal/${center.body.data.slug as string}/auth/register`))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const live = await connect(customer.body.data.accessToken as string);
      expect(await live.disconnected).toBe('io server disconnect');
      expect(live.events.map((e) => e.name)).not.toContain('agent.online');
    });

    it('refuses a person whose access already ended at connect, with the reason', async () => {
      await session(owner);
      const agented = await session(agent);
      provider.setPersonAnswer(ORG_A, 'sub-agent', { decision: 'deny', reason: 'membership_inactive' });
      await windowPasses();
      const live = await connect(agented.token);
      expect(await live.ended()).toEqual({ code: 'WORKEASY360_ACCESS_ENDED', reason: 'membership_inactive' });
      expect(await live.disconnected).toBe('io server disconnect');
    });

    it('disconnects an open socket within one re-check after access ends, while refresh keeps working', async () => {
      const owned = await session(owner);
      const live = await connect(owned.token);
      await live.connected;
      await settle(500);
      expect(live.socket.connected).toBe(true);

      provider.setOrganizationAnswer(ORG_A, { decision: 'deny', reason: 'expired' });
      await windowPasses();
      expect(await live.ended()).toEqual({ code: 'WORKEASY360_ACCESS_ENDED', reason: 'expired' });
      expect(await live.disconnected).toBe('io server disconnect');

      // The person can still reach the access-ended screen (refresh is public)...
      const renewed = await refresh(owned.cookie);
      await request(http).get(apiPath('/auth/me')).set('Authorization', `Bearer ${renewed.token}`).expect(200);
      // ...but a new socket is refused again.
      const again = await connect(renewed.token);
      expect((await again.ended()).code).toBe('WORKEASY360_ACCESS_ENDED');
    });

    it('ends only the denied person\'s socket', async () => {
      const owned = await session(owner);
      const agented = await session(agent);
      const first = await connect(owned.token);
      const second = await connect(agented.token);
      await Promise.all([first.connected, second.connected]);

      provider.setPersonAnswer(ORG_A, 'sub-agent', { decision: 'deny', reason: 'membership_inactive' });
      await windowPasses();
      await second.ended();
      expect(first.socket.connected).toBe(true);
    });

    it('an outage of the entitlement API does not disconnect anyone', async () => {
      const owned = await session(owner);
      const live = await connect(owned.token);
      await live.connected;
      provider.entitlementFailure = 503;
      await windowPasses();
      await settle(2500);
      expect(live.socket.connected).toBe(true);
    });

    it('a refusal of our own client disconnects (access.ended with WORKEASY360_ACCESS_UNVERIFIED)', async () => {
      const owned = await session(owner);
      const live = await connect(owned.token);
      await live.connected;
      provider.entitlementFailure = 403;
      await windowPasses();
      expect((await live.ended()).code).toBe('WORKEASY360_ACCESS_UNVERIFIED');
    });
  });

  // --- how a session was started, and linking ---------------------------------------------------

  describe('sessions and linking', () => {
    it('records the sign-in method on the refresh token (PASSWORD for a password sign-in)', async () => {
      await helpers.registerOrg(http, 'methods');
      await request(http).post(apiPath('/auth/login')).send({ email: 'owner@methods.example', password: 'Str0ngPassword1' }).expect(200);
      const tokens = await harness.prisma.refreshToken.findMany();
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.every((t) => t.authMethod === 'PASSWORD')).toBe(true);

      await signIn(owner);
      const sso = await harness.prisma.refreshToken.findMany({ where: { authMethod: 'WORKEASY360' } });
      expect(sso).toHaveLength(1);
    });

    it('keeps password sessions working when SSO-only is off (development)', async () => {
      const legacy = await helpers.registerOrg(http, 'devmode');
      const login = await request(http).post(apiPath('/auth/login')).send({ email: 'owner@devmode.example', password: 'Str0ngPassword1' }).expect(200);
      await request(http).post(apiPath('/auth/refresh')).set('Cookie', pair(login, REFRESH_COOKIE)!).expect(200);
      await linkOrganization(harness.prisma, legacy.organizationId, ORG_A);
      // Bound later: an agent token issued afterwards is checked per organization, never refused.
      const relogin = await request(http).post(apiPath('/auth/login')).send({ email: 'owner@devmode.example', password: 'Str0ngPassword1' }).expect(200);
      await request(http)
        .get(apiPath('/tickets'))
        .set('Authorization', `Bearer ${relogin.body.data.accessToken as string}`)
        .expect(200);
    });

    it('the link command ends the organization\'s agent sessions and leaves customers alone', async () => {
      const legacy = await helpers.registerOrg(http, 'revoke');
      const login = await request(http).post(apiPath('/auth/login')).send({ email: 'owner@revoke.example', password: 'Str0ngPassword1' }).expect(200);
      const agentCookie = pair(login, REFRESH_COOKIE)!;
      const center = await request(http).get(apiPath('/help-center')).set({ Authorization: `Bearer ${legacy.token}` }).expect(200);
      const slug = center.body.data.slug as string;
      const customer = await request(http)
        .post(apiPath(`/portal/${slug}/auth/register`))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const customerCookie = pair(customer, 'ds_portal_refresh')!;

      await linkOrganization(harness.prisma, legacy.organizationId, ORG_A);

      await request(http).post(apiPath('/auth/refresh')).set('Cookie', agentCookie).expect(401);
      await request(http).post(apiPath(`/portal/${slug}/auth/refresh`)).set('Cookie', customerCookie).expect(200);
    });

    it('linking an account invalidates its outstanding reset and invitation links', async () => {
      const legacy = await helpers.registerOrg(http, 'pretokens', 'owner@acme.example');
      await linkOrganization(harness.prisma, legacy.organizationId, ORG_A);
      const { TokenService } = await import('../src/auth/token.service');
      const hash = (raw: string) => harness.app.get(TokenService).hashRefreshToken(raw);
      for (const [type, raw] of [['PASSWORD_RESET', 'reset-token-0123456789abcdef'], ['INVITE', 'invite-token-0123456789abcdef']] as const) {
        await harness.prisma.verificationToken.create({
          data: { userId: legacy.userId, type, tokenHash: hash(raw), expiresAt: new Date(Date.now() + 3600_000) },
        });
      }
      // An unrelated address verification link is not a way to set a password: it is left alone.
      await harness.prisma.verificationToken.create({
        data: { userId: legacy.userId, type: 'EMAIL_VERIFICATION', tokenHash: hash('verify-token-0123456789abcdef'), expiresAt: new Date(Date.now() + 3600_000) },
      });

      await signIn(owner);

      const rows = await harness.prisma.verificationToken.findMany({ where: { userId: legacy.userId } });
      const used = Object.fromEntries(rows.map((r) => [r.type, r.usedAt !== null]));
      expect(used['PASSWORD_RESET']).toBe(true);
      expect(used['INVITE']).toBe(true);
      expect(used['EMAIL_VERIFICATION']).toBe(false);
      await request(http)
        .post(apiPath('/auth/reset-password'))
        .send({ token: 'reset-token-0123456789abcdef', password: 'Brand-New-Pass9' })
        .expect(400);
      expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: legacy.userId } })).passwordHash).toBeNull();
    });
  });

  // --- agent tokens and read-only on the help center ----------------------------------------------

  describe('the help center and agent tokens', () => {
    it('applies the per-person check to an agent token: an agent whose access ended cannot read agent-only content', async () => {
      const owned = await session(owner);
      const agented = await session(agent);
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const slug = center.body.data.slug as string;
      await request(http).get(apiPath(`/portal/${slug}/kb/categories`)).set(agented.bearer).expect(200);

      provider.setPersonAnswer(ORG_A, 'sub-agent', { decision: 'deny', reason: 'membership_inactive' });
      await windowPasses();

      const refused = await request(http).get(apiPath(`/portal/${slug}/kb/categories`)).set(agented.bearer).expect(403);
      expect(refused.body.error.code).toBe('WORKEASY360_ACCESS_ENDED');
      expect(refused.body.error.details).toEqual({ reason: 'membership_inactive' });
      // The organization is fine, so anonymous visitors and the other agent are served.
      await request(http).get(apiPath(`/portal/${slug}/kb/categories`)).expect(200);
      await request(http).get(apiPath(`/portal/${slug}/kb/categories`)).set(owned.bearer).expect(200);
    });

    it('does not write to a read-only organization, customers included, but lets them read and keep their session', async () => {
      const owned = await session(owner);
      const center = await request(http).get(apiPath('/help-center')).set(owned.bearer).expect(200);
      const slug = center.body.data.slug as string;
      const customer = await request(http)
        .post(apiPath(`/portal/${slug}/auth/register`))
        .send({ firstName: 'Rhea', email: 'rhea@example.com', password: 'PortalPass123' })
        .expect(201);
      const cookie = pair(customer, 'ds_portal_refresh')!;
      const bearer = { Authorization: `Bearer ${customer.body.data.accessToken as string}` };

      provider.setOrganizationAnswer(ORG_A, { decision: 'allow', reason: 'read_only', write_allowed: false });
      await windowPasses();

      // Reads and the session routes work...
      await request(http).get(apiPath(`/portal/${slug}`)).expect(200);
      await request(http).get(apiPath(`/portal/${slug}/tickets`)).set(bearer).expect(200);
      await request(http).post(apiPath(`/portal/${slug}/auth/refresh`)).set('Cookie', cookie).expect(200);
      await request(http).post(apiPath(`/portal/${slug}/auth/login`)).send({ email: 'rhea@example.com', password: 'PortalPass123' }).expect(200);
      // ...writes do not.
      const submit = await request(http)
        .post(apiPath(`/portal/${slug}/forms/contact-support/submit`))
        .send({ values: { name: 'N', email: 'n@example.com', subject: 's', description: 'd' } })
        .expect(403);
      expect(submit.body.error.code).toBe('HELP_CENTER_UNAVAILABLE');
      await request(http)
        .post(apiPath(`/portal/${slug}/tickets`))
        .set(bearer)
        .send({ subject: 'Export crashes', description: 'Above 500 rows the tab dies.' })
        .expect(403);
      await request(http)
        .post(apiPath(`/portal/${slug}/auth/register`))
        .send({ firstName: 'Omar', email: 'omar@example.com', password: 'PortalPass123' })
        .expect(403);

      provider.setOrganizationAnswer(ORG_A, null);
      await windowPasses();
      await request(http)
        .post(apiPath(`/portal/${slug}/tickets`))
        .set(bearer)
        .send({ subject: 'Export crashes', description: 'Above 500 rows the tab dies.' })
        .expect(201);
    });
  });

  // --- the frontend's signed-out marker -----------------------------------------------------

  describe('the signed-out marker the frontend keeps (plain http: the unprefixed names)', () => {
    const markers = (response: request.Response): string[] => setCookies(response).filter((c) => /hd_signed_out=/.test(c));

    it('is expired by a successful sign-in, host-only at Path=/ (the cookie the frontend wrote), and nothing else is touched', async () => {
      const result = await signIn(owner);
      expect(result.callback.status).toBe(302);
      const cleared = markers(result.callback);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatch(/^hd_signed_out=;/);
      expect(cleared[0]).toContain('Path=/;');
      expect(cleared[0]).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(cleared[0]).not.toMatch(/Domain=/i);
      // Over plain http no __Host- cookie is attempted (a browser would refuse it anyway).
      expect(cleared.some((c) => c.startsWith('__Host-'))).toBe(false);
    });

    it('is left alone by every refused sign-in', async () => {
      const result = await signIn(owner, { callbackQuery: () => new URLSearchParams({ error: 'access_denied', state: 'x' }) });
      expect(result.landing).toBe(loginError('cancelled'));
      expect(markers(result.callback)).toEqual([]);
    });

    it('is left alone by a refresh: only a real sign-in clears it', async () => {
      const { cookie } = await session(owner);
      const renewed = await refresh(cookie);
      expect(markers(renewed.response)).toEqual([]);
    });
  });
});
