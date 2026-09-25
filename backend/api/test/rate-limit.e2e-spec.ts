import request from 'supertest';
import type { Server } from 'node:http';

// The environment is read when the application module is first evaluated, so the flag
// has to be set before the harness (and through it, AppModule) is required.
process.env.THROTTLE_ENABLED = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const harnessModule = require('./app.harness') as typeof import('./app.harness');
const { apiPath, createHarness, resetDatabase } = harnessModule;

/** The one suite that keeps the real ThrottlerGuard in play. */
describe('Rate limiting (e2e)', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  let http: Server;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
    // Throttle counters live in Redis; a rerun inside the window must start from zero.
    await resetDatabase(harness.prisma, harness.redis);
  });

  afterAll(async () => {
    await harness.close();
  });

  // The auth throttler (AUTH_THROTTLE_LIMIT, 10 a minute) is opt-in per route; an
  // ordinary API call or a health probe must not hit it.
  it('does not hold ordinary routes or health probes to the auth limit', async () => {
    const register = await request(http)
      .post(apiPath('/auth/register'))
      .send({
        organizationName: 'Throttle Co',
        organizationSlug: 'throttle',
        firstName: 'Ada',
        lastName: 'Admin',
        email: 'ada@throttle.example',
        password: 'Str0ngPassword1',
      })
      .expect(201);
    const auth = { Authorization: `Bearer ${register.body.data.accessToken as string}` };

    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push((await request(http).get(apiPath('/tickets')).set(auth)).status);
      statuses.push((await request(http).get(apiPath('/auth/me')).set(auth)).status);
      statuses.push((await request(http).get(apiPath('/health/live'))).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('throttles repeated failed logins instead of letting them run unbounded', async () => {
    const attempt = () =>
      request(http)
        .post(apiPath('/auth/login'))
        .send({ email: 'someone@example.test', password: 'Wr0ngPassword1' });

    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await attempt()).status);
    }

    expect(statuses).toContain(401);
    expect(statuses).toContain(429);
    // The limiter bites well before a dozen attempts get through.
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(10);
  });
});
