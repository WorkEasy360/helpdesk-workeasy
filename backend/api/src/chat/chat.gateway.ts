import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AppConfig } from '../config/config.module';
import { CHAT_BRIDGE_CHANNEL, chatRoom, type ChatEnvelope } from './chat.events';
import { allowedOriginsOf, isWidgetOriginAllowed } from './widget-origin';

/**
 * The visitor's socket. It is authenticated by the session token the widget was given
 * when the chat started — no account, no bearer token — and a socket only ever joins
 * the room of the one session that token belongs to. Transport CORS is open (see
 * RedisIoAdapter); the handshake Origin is checked against the channel's allowedOrigins.
 */
@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ChatGateway.name);
  private subscriber?: Redis;

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CHAT_BRIDGE_CHANNEL);
    this.subscriber.on('message', (_channel, raw) => {
      try {
        const envelope = JSON.parse(raw) as ChatEnvelope;
        this.server?.to(envelope.room).emit(envelope.event, envelope.payload);
      } catch (error) {
        this.logger.warn(
          `Discarded malformed chat envelope: ${error instanceof Error ? error.message : error}`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit();
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth as { token?: string } | undefined)?.token ??
      (typeof client.handshake.query.token === 'string' ? client.handshake.query.token : undefined);

    if (!token) {
      client.disconnect(true);
      return;
    }

    const session = await this.prisma.chatSession.findFirst({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      select: { id: true, status: true, organizationId: true, channel: { select: { config: true } } },
    });
    if (!session || session.status === 'ENDED') {
      client.disconnect(true);
      return;
    }
    if (
      !isWidgetOriginAllowed(
        client.handshake.headers.origin,
        this.config.get('FRONTEND_URL'),
        allowedOriginsOf(session.channel?.config),
      )
    ) {
      client.disconnect(true);
      return;
    }

    client.data.sessionId = session.id;
    await client.join(chatRoom(session.id));
    await this.prisma.chatSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
  }

  handleDisconnect(client: Socket): void {
    const sessionId = client.data.sessionId as string | undefined;
    if (sessionId) {
      this.logger.debug(`Chat visitor left ${sessionId}`);
    }
  }
}
