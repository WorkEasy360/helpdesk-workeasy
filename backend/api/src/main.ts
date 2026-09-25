import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import { AppModule } from './app.module';
import { AppConfig } from './config/config.module';
import { webhookBodyLimit } from './config/env.schema';
import { REDIS_CLIENT } from './redis/redis.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

const JSON_TYPE = /^application\/([\w.+-]+\+)?json\b/i;
const FORM_TYPE = /^application\/x-www-form-urlencoded\b/i;

async function bootstrap(): Promise<void> {
  // rawBody keeps the exact bytes a provider signed; webhook verification needs them.
  // Body parsers are registered below (useBodyParser keeps rawBody) so each gets a limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(AppConfig);
  const prefix = config.get('API_PREFIX');

  app.useLogger(app.get(PinoLogger));
  // Behind Nginx/an ALB the socket peer is the proxy; this decides which forwarded
  // headers are believed for req.ip and req.protocol.
  app.set('trust proxy', config.get('TRUST_PROXY'));
  app.setGlobalPrefix(prefix);

  // Channel webhooks may carry base64 attachments, so they get a ceiling sized from
  // ATTACHMENT_MAX_BYTES; every other route keeps the much smaller BODY_LIMIT. The first
  // parser to match a request consumes it, and the next one skips it.
  const webhookPath = `/${prefix}/webhooks/`;
  const isWebhook = (req: IncomingMessage) =>
    ((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '').startsWith(
      webhookPath,
    );
  const contentType = (req: IncomingMessage) => req.headers['content-type'] ?? '';
  const webhookLimit = webhookBodyLimit({
    WEBHOOK_BODY_LIMIT: config.get('WEBHOOK_BODY_LIMIT'),
    ATTACHMENT_MAX_BYTES: config.get('ATTACHMENT_MAX_BYTES'),
  });
  app.useBodyParser('json', {
    limit: webhookLimit,
    type: (req: IncomingMessage) => isWebhook(req) && JSON_TYPE.test(contentType(req)),
  });
  app.useBodyParser('urlencoded', {
    limit: webhookLimit,
    extended: true,
    type: (req: IncomingMessage) => isWebhook(req) && FORM_TYPE.test(contentType(req)),
  });
  app.useBodyParser('json', { limit: config.get('BODY_LIMIT') });
  app.useBodyParser('urlencoded', { limit: config.get('BODY_LIMIT'), extended: true });

  app.use(helmet());
  app.use(cookieParser());

  // The agent app and portal are served from FRONTEND_URL. The chat widget's public
  // endpoints are reachable from any embedding site — the per-channel allowedOrigins
  // check in the chat controller is what enforces who may embed it — and carry no
  // ambient credentials (the visitor token is a header).
  const frontendOrigin = new URL(config.get('FRONTEND_URL')).origin;
  const publicChatPath = new RegExp(`^/${prefix}/portal/[^/]+/chat(/|\\?|$)`);
  app.enableCors((req: { url?: string; originalUrl?: string }, callback) => {
    const path = req.originalUrl ?? req.url ?? '';
    callback(null, {
      origin: publicChatPath.test(path) ? true : frontendOrigin,
      credentials: true,
    });
  });
  app.enableShutdownHooks();

  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis(app.get<Redis>(REDIS_CLIENT));
  app.useWebSocketAdapter(redisAdapter);

  await app.listen(config.get('PORT'), '0.0.0.0');
}

void bootstrap();
