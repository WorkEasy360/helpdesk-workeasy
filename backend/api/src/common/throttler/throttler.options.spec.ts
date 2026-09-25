import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { Server } from 'node:http';
import { AUTH_THROTTLE_LIMIT_KEY, buildThrottlerOptions } from './throttler.options';

@Controller()
class ProbeController {
  @Get('plain')
  plain() {
    return 'ok';
  }

  @Throttle({ auth: { limit: 2, ttl: 60_000 } })
  @Get('login')
  login() {
    return 'ok';
  }

  @SkipThrottle({ default: true, auth: true })
  @Get('health')
  health() {
    return 'ok';
  }
}

describe('throttler scoping', () => {
  let app: INestApplication;
  let http: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          // `default` is generous; `auth` would bite on the third request anywhere.
          buildThrottlerOptions({ enabled: true, ttlSeconds: 60, limit: 50, authLimit: 3 }),
        ),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  const hit = async (path: string, times: number) => {
    const statuses: number[] = [];
    for (let i = 0; i < times; i += 1) {
      statuses.push((await request(http).get(path)).status);
    }
    return statuses;
  };

  it('keeps the auth limit off routes that do not opt in', async () => {
    expect(await hit('/plain', 10)).toEqual(new Array(10).fill(200));
  });

  it('applies the auth limit where a route opts in', async () => {
    const statuses = await hit('/login', 4);
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it('never throttles a skipped route', async () => {
    expect(await hit('/health', 60)).not.toContain(429);
  });

  it('matches the metadata key the Throttle decorator writes', () => {
    const limit = Reflect.getMetadata(AUTH_THROTTLE_LIMIT_KEY, ProbeController.prototype.login);
    expect(limit).toBe(2);
  });
});
