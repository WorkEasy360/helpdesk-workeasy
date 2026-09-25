import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

/** Lets Socket.IO fan out across every API instance behind the load balancer. */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  async connectToRedis(redis: Redis): Promise<void> {
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();
    this.clients = [pubClient, subClient];
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    // Both namespaces share one engine, and whichever gateway initialised first used
    // to decide CORS for both. CORS is set once here instead: any origin may open the
    // transport, because the chat widget is embedded on customer sites, and each
    // namespace checks the handshake Origin itself (/rt: FRONTEND_URL only; /chat: the
    // channel's allowedOrigins). Neither namespace authenticates with cookies.
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: true, credentials: true },
    } as ServerOptions) as {
      adapter: (factory: unknown) => void;
    };
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  override async dispose(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.quit()));
  }
}
