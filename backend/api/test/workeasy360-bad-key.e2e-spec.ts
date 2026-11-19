import request from 'supertest';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { Harness } from './app.harness';
import { FakeWorkeasy360 } from './support/fake-workeasy360';

/**
 * A client key that cannot be read (a missing or unreadable WORKEASY360_PRIVATE_KEY_FILE) is a
 * misconfiguration, not a crash: no request answers 500. Sign-in says "unavailable",
 * entitlement checks behave like an outage of Workeasy360 (the last answer stands; with none,
 * access continues), and a denial that is already known is not forgotten.
 */

const FRONTEND = 'http://localhost:3000';
const ORG_A = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const apiPath = (path: string): string => `/api/v1${path}`;

describe('an unreadable Workeasy360 key file (e2e)', () => {
  let provider: FakeWorkeasy360;
  let harness: Harness;
  let http: Server;
  let helpers: typeof import('./app.harness');
  let linkOrganization: typeof import('../src/workeasy360/link-organization').linkOrganization;
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  beforeAll(async () => {
    provider = await FakeWorkeasy360.start({
      redirectUri: `${FRONTEND}/api/auth/callback/workeasy360`,
      appPublicKey: appKeys.publicKey,
    });
    Object.assign(process.env, {
      WORKEASY360_ISSUER: provider.issuer,
      WORKEASY360_CLIENT_ID: provider.clientId,
      WORKEASY360_REDIRECT_URI: `${FRONTEND}/api/auth/callback/workeasy360`,
      WORKEASY360_KEY_ID: provider.keyId,
      WORKEASY360_PRIVATE_KEY_FILE: '/definitely/not/here/workeasy360.key',
      WORKEASY360_SSO_ONLY: 'false',
    });
    helpers = await import('./app.harness');
    harness = await helpers.createHarness();
    http = harness.app.getHttpServer() as Server;
    ({ linkOrganization } = await import('../src/workeasy360/link-organization'));
  }, 240_000);

  beforeEach(async () => {
    await helpers.resetDatabase(harness.prisma, harness.redis);
    provider.reset();
  });

  afterAll(async () => {
    await harness?.close();
    await provider?.stop();
  });

  async function linkedAgent() {
    const org = await helpers.registerOrg(http, 'badkey');
    await linkOrganization(harness.prisma, org.organizationId, ORG_A);
    const login = await request(http)
      .post(apiPath('/auth/login'))
      .send({ email: 'owner@badkey.example', password: 'Str0ngPassword1' })
      .expect(200);
    const slug = (await harness.prisma.helpCenter.findFirstOrThrow({ where: { organizationId: org.organizationId } })).slug;
    return { org, slug, bearer: { Authorization: `Bearer ${login.body.data.accessToken as string}` } };
  }

  it('sign-in routes answer "unavailable", not 500', async () => {
    const start = await request(http).get('/api/auth/workeasy360/start').expect(302);
    expect(start.headers['location']).toBe(`${FRONTEND}/login?sso_error=unavailable`);
    const logout = await request(http).get('/api/auth/workeasy360/logout').expect(302);
    expect(logout.headers['location']).toBe(`${FRONTEND}/login`);
    const methods = await request(http).get(apiPath('/auth/methods')).expect(200);
    expect(methods.body.data.workeasy360).toBe(true);
  });

  it('agent and help center requests of a linked organization still work: an outage lets access continue', async () => {
    const agent = await linkedAgent();
    await request(http).get(apiPath('/tickets')).set(agent.bearer).expect(200);
    await request(http).patch(apiPath('/auth/me')).set(agent.bearer).send({ firstName: 'X' }).expect(200);
    await request(http).get(apiPath(`/portal/${agent.slug}`)).expect(200);
    expect(provider.entitlementCalls).toHaveLength(0);
  });

  it('a denial that is already known stands through the outage', async () => {
    const agent = await linkedAgent();
    await harness.redis.set(
      `w360:ent:org:${ORG_A}`,
      JSON.stringify({ d: 'deny', r: 'expired', w: false, at: Date.now() - 3600_000, fresh: 900 }),
    );
    const refused = await request(http).get(apiPath('/tickets')).set(agent.bearer).expect(403);
    expect(refused.body.error.code).toBe('WORKEASY360_ACCESS_ENDED');
    await request(http).get(apiPath(`/portal/${agent.slug}`)).expect(403);
  });

  it('password sign-in is unaffected', async () => {
    await helpers.registerOrg(http, 'fine');
    await request(http).post(apiPath('/auth/login')).send({ email: 'owner@fine.example', password: 'Str0ngPassword1' }).expect(200);
  });
});
