import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/config.module';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfig],
      useFactory: (config: AppConfig): Redis =>
        new Redis(config.get('REDIS_URL'), { maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Runs after the HTTP server has stopped taking requests; QUIT lets pending replies drain. */
  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') {
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
