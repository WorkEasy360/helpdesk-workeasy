import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { QUEUE_NAMES } from './queue.constants';

export const EMAIL_QUEUE = Symbol('EMAIL_QUEUE');
export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');
export const AUTOMATION_QUEUE_TOKEN = Symbol('AUTOMATION_QUEUE');
export const SLA_QUEUE_TOKEN = Symbol('SLA_QUEUE');
export const CHANNEL_QUEUE_TOKEN = Symbol('CHANNEL_QUEUE');
export const WEBHOOK_QUEUE_TOKEN = Symbol('WEBHOOK_QUEUE');
export const AI_QUEUE_TOKEN = Symbol('AI_QUEUE');
export const ANALYTICS_QUEUE_TOKEN = Symbol('ANALYTICS_QUEUE');

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

function queueFactory(name: string) {
  return (redis: Redis): Queue =>
    new Queue(name, { connection: redis.duplicate(), defaultJobOptions });
}

@Global()
@Module({
  providers: [
    { provide: EMAIL_QUEUE, inject: [REDIS_CLIENT], useFactory: queueFactory(QUEUE_NAMES.EMAIL) },
    {
      provide: NOTIFICATION_QUEUE,
      inject: [REDIS_CLIENT],
      useFactory: queueFactory(QUEUE_NAMES.NOTIFICATIONS),
    },
    {
      provide: AUTOMATION_QUEUE_TOKEN,
      inject: [REDIS_CLIENT],
      useFactory: queueFactory(QUEUE_NAMES.AUTOMATION),
    },
    { provide: SLA_QUEUE_TOKEN, inject: [REDIS_CLIENT], useFactory: queueFactory(QUEUE_NAMES.SLA) },
    {
      provide: CHANNEL_QUEUE_TOKEN,
      inject: [REDIS_CLIENT],
      useFactory: queueFactory(QUEUE_NAMES.CHANNEL),
    },
    {
      provide: WEBHOOK_QUEUE_TOKEN,
      inject: [REDIS_CLIENT],
      useFactory: queueFactory(QUEUE_NAMES.WEBHOOK),
    },
    { provide: AI_QUEUE_TOKEN, inject: [REDIS_CLIENT], useFactory: queueFactory(QUEUE_NAMES.AI) },
    {
      provide: ANALYTICS_QUEUE_TOKEN,
      inject: [REDIS_CLIENT],
      useFactory: queueFactory(QUEUE_NAMES.ANALYTICS),
    },
  ],
  exports: [
    EMAIL_QUEUE,
    NOTIFICATION_QUEUE,
    AUTOMATION_QUEUE_TOKEN,
    SLA_QUEUE_TOKEN,
    CHANNEL_QUEUE_TOKEN,
    WEBHOOK_QUEUE_TOKEN,
    AI_QUEUE_TOKEN,
    ANALYTICS_QUEUE_TOKEN,
  ],
})
export class QueueModule implements OnApplicationShutdown {
  private readonly queues: Queue[];

  constructor(
    @Inject(EMAIL_QUEUE) email: Queue,
    @Inject(NOTIFICATION_QUEUE) notifications: Queue,
    @Inject(AUTOMATION_QUEUE_TOKEN) automation: Queue,
    @Inject(SLA_QUEUE_TOKEN) sla: Queue,
    @Inject(CHANNEL_QUEUE_TOKEN) channel: Queue,
    @Inject(WEBHOOK_QUEUE_TOKEN) webhook: Queue,
    @Inject(AI_QUEUE_TOKEN) ai: Queue,
    @Inject(ANALYTICS_QUEUE_TOKEN) analytics: Queue,
  ) {
    this.queues = [email, notifications, automation, sla, channel, webhook, ai, analytics];
  }

  /**
   * Each queue holds its own duplicated connection, which BullMQ does not close for a
   * connection it was handed — so the queue is closed first, then its connection.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(
      this.queues.map(async (queue) => {
        await queue.close();
        const connection = queue.opts.connection as Redis;
        if (connection.status !== 'end') {
          await connection.quit().catch(() => connection.disconnect());
        }
      }),
    );
  }
}
