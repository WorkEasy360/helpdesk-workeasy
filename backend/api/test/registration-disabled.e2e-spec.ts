import request from 'supertest';
import type { Server } from 'node:http';

// Read when the application module is first evaluated, so it has to be set before the
// harness (and through it, AppModule) is required.
process.env.ALLOW_PUBLIC_REGISTRATION = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const harnessModule = require('./app.harness') as typeof import('./app.harness');
const { apiPath, createHarness, resetDatabase } = harnessModule;

/** Invite-only deployments: no one can create a new organization from the sign-up page. */
describe('Public registration disabled (e2e)', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let http: Server;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
    await resetDatabase(harness.prisma);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('tells the sign-up page registration is off', async () => {
    const response = await request(http).get(apiPath('/auth/register')).expect(200);
    expect(response.body.data).toEqual({ enabled: false });
  });

  it('refuses to create an organization with 403 and writes nothing', async () => {
    const response = await request(http)
      .post(apiPath('/auth/register'))
      .send({
        organizationName: 'Closed Co',
        organizationSlug: 'closed',
        firstName: 'Ada',
        lastName: 'Admin',
        email: 'ada@closed.example',
        password: 'Str0ngPassword1',
      })
      .expect(403);

    expect(response.body.error.code).toBe('REGISTRATION_DISABLED');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await harness.prisma.organization.count()).toBe(0);
  });
});
