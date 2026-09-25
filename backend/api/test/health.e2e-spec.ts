import request from 'supertest';
import type { Server } from 'node:http';
import { apiPath, createHarness, type Harness } from './app.harness';

describe('Health probes (e2e)', () => {
  let harness: Harness;
  let http: Server;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('reports ready with both dependencies up, without authentication', async () => {
    const response = await request(http).get(apiPath('/health')).expect(200);
    expect(response.body.data).toMatchObject({
      status: 'ok',
      dependencies: { database: 'up', redis: 'up' },
    });
    expect(Number.isNaN(Date.parse(response.body.data.timestamp))).toBe(false);
  });

  it('answers the liveness probe without touching dependencies', async () => {
    const response = await request(http).get(apiPath('/health/live')).expect(200);
    expect(response.body.data).toMatchObject({ status: 'ok' });
  });
});
