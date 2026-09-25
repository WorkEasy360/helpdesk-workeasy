import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

const PROBE_TIMEOUT_MS = 2000;

function probe(check: Promise<unknown>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => resolve('down'), PROBE_TIMEOUT_MS);
  });
  return Promise.race([
    check.then(
      () => 'up' as const,
      () => 'down' as const,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/** Probes poll these constantly, so they are never rate limited. */
@SkipThrottle({ default: true, auth: true })
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Readiness: 503 while the database or Redis is unreachable, so a load balancer stops
   * routing here. The body is the same either way.
   */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      probe(this.prisma.$queryRaw`SELECT 1`),
      // The shared client queues commands while disconnected (maxRetriesPerRequest is
      // null for BullMQ), so without the timeout this would hang rather than fail.
      probe(this.redis.ping()),
    ]);

    const healthy = database === 'up' && redis === 'up';
    if (!healthy) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: healthy ? 'ok' : 'degraded',
      dependencies: { database, redis },
      timestamp: new Date().toISOString(),
    };
  }

  /** Liveness: the process is up and serving. Never depends on anything downstream. */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
