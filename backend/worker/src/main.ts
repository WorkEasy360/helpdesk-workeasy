import { Queue, Worker, type Job } from 'bullmq';
import { AUTOMATION_QUEUE, SLA_QUEUE, SLA_SCAN_JOB, type EngineDeps, type TriggerJob } from '@digisoft/engine';
import { handleAutomation } from './processors/automation.processor';
import { handleSlaScan } from './processors/sla.processor';
import { PrismaClient } from '@digisoft/db';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadEnv } from './config';
import { createEmailProvider } from './email-provider';
import { handleSendEmail, type SendEmailJob } from './processors/send-email.processor';
import {
  handleDeliverNotification,
  type DeliverNotificationJob,
} from './processors/deliver-notification.processor';
import { handleChannelSend, type ChannelSendJob } from './processors/channel-send.processor';
import { handleWebhookDelivery, type WebhookDeliveryJob } from './processors/webhook.processor';
import { handleAiAnalyse, type AiAnalyseJob } from './processors/ai.processor';
import type { AiDeps } from '@digisoft/ai';
import {
  handleMetricsRollup,
  handleReportExport,
  type AnalyticsProcessorDeps,
  type ReportExportJob,
} from './processors/analytics.processor';
import { createStorageProvider } from '@digisoft/storage';
import {
  BackgroundGate,
  EntitlementCache,
  RedisKeyValueStore,
  Workeasy360Client,
  hasClientCredentials,
  readPrivateKeyPem,
} from '@digisoft/workeasy360';
import { OPEN_GATE, type AccessGate } from './access-gate';

const env = loadEnv();
const logger = pino({ level: env.LOG_LEVEL, name: 'worker' });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prisma = new PrismaClient({
  // See api/src/prisma/prisma.service.ts: Prisma's 5s default is too short against a
  // distant database.
  transactionOptions: {
    timeout: env.DB_TRANSACTION_TIMEOUT_MS,
    maxWait: env.DB_TRANSACTION_MAX_WAIT_MS,
  },
});
const emailProvider = createEmailProvider(env);

/**
 * Background work that produces a business effect re-checks the organization's Workeasy360
 * entitlement first (class A); only organizations bound to Workeasy360 are asked about.
 */
const gateLogger = {
  info: (meta: Record<string, unknown>, message: string) => logger.info(meta, message),
  warn: (meta: Record<string, unknown>, message: string) => logger.warn(meta, message),
  error: (meta: Record<string, unknown>, message: string) => logger.error(meta, message),
};
const gate: AccessGate = hasClientCredentials(env)
  ? new BackgroundGate({
      prisma,
      logger: gateLogger,
      entitlements: new EntitlementCache({
        source: new Workeasy360Client({
          issuer: env.WORKEASY360_ISSUER!,
          clientId: env.WORKEASY360_CLIENT_ID!,
          keyId: env.WORKEASY360_KEY_ID!,
          privateKeyPem: readPrivateKeyPem({
            file: env.WORKEASY360_PRIVATE_KEY_FILE,
            inline: env.WORKEASY360_PRIVATE_KEY,
          }),
        }),
        store: new RedisKeyValueStore(connection),
        logger: gateLogger,
      }),
    })
  : OPEN_GATE;

/**
 * BullMQ does not close a connection it was handed, so every duplicate is tracked here
 * and closed at shutdown after the workers and queues that use it.
 */
const connections: Redis[] = [];
function duplicate(): Redis {
  const client = connection.duplicate();
  connections.push(client);
  return client;
}

const emailQueue = new Queue('email', { connection: duplicate() });
const automationQueue = new Queue<TriggerJob>(AUTOMATION_QUEUE, { connection: duplicate() });
const slaQueue = new Queue(SLA_QUEUE, { connection: duplicate() });
const analyticsQueue = new Queue('analytics', { connection: duplicate() });

const aiDeps: AiDeps = {
  prisma,
  encryptionKey: env.CHANNEL_ENCRYPTION_KEY,
  log: (level, message, meta) =>
    logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](meta ?? {}, message),
};

const analyticsDeps: AnalyticsProcessorDeps = {
  prisma,
  logger,
  storage: createStorageProvider({
    provider: env.STORAGE_PROVIDER,
    localPath: env.STORAGE_LOCAL_PATH,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    signedUrlTtl: env.S3_SIGNED_URL_TTL_SECONDS,
  }),
  rollupDays: env.METRICS_ROLLUP_DAYS,
  log: (level, message, meta) =>
    logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](meta ?? {}, message),
};

const engineDeps: EngineDeps = {
  prisma,
  redis: connection,
  emailQueue,
  log: (level, message, meta) => logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](meta ?? {}, message),
};

const emailWorker = new Worker<SendEmailJob>(
  'email',
  (job: Job<SendEmailJob>) => handleSendEmail(job, { emailProvider, logger, gate }),
  { connection: duplicate(), concurrency: env.WORKER_CONCURRENCY },
);

const notificationWorker = new Worker<DeliverNotificationJob>(
  'notifications',
  (job: Job<DeliverNotificationJob>) =>
    handleDeliverNotification(job, { prisma, redis: connection, logger, gate }),
  { connection: duplicate(), concurrency: env.WORKER_CONCURRENCY },
);

const automationWorker = new Worker<TriggerJob>(
  AUTOMATION_QUEUE,
  (job: Job<TriggerJob>) => handleAutomation(job, engineDeps, gate),
  { connection: duplicate(), concurrency: env.WORKER_CONCURRENCY },
);

const channelWorker = new Worker<ChannelSendJob>(
  'channel',
  (job: Job<ChannelSendJob>) =>
    handleChannelSend(job, {
      prisma,
      logger,
      sendEmail: (message) => emailProvider.send(message),
      encryptionKey: env.CHANNEL_ENCRYPTION_KEY,
      gate,
    }),
  { connection: duplicate(), concurrency: env.WORKER_CONCURRENCY },
);

const webhookWorker = new Worker<WebhookDeliveryJob>(
  'webhook',
  (job: Job<WebhookDeliveryJob>) =>
    handleWebhookDelivery(job, { prisma, logger, maxAttempts: env.WEBHOOK_MAX_ATTEMPTS, gate }),
  { connection: duplicate(), concurrency: env.WORKER_CONCURRENCY },
);

const aiWorker = new Worker<AiAnalyseJob>(
  'ai',
  (job: Job<AiAnalyseJob>) => handleAiAnalyse(job, { ...aiDeps, logger, gate }),
  // The assistant is the slowest thing the worker does; keep it off the other lanes.
  { connection: duplicate(), concurrency: 2 },
);

const analyticsWorker = new Worker<ReportExportJob>(
  'analytics',
  (job: Job<ReportExportJob>) =>
    job.name === 'metrics-rollup'
      ? handleMetricsRollup(analyticsDeps)
      : handleReportExport(job, analyticsDeps),
  // Rollups scan the ticket table; one at a time keeps them off the other lanes.
  { connection: duplicate(), concurrency: 1 },
);

const slaWorker = new Worker(
  SLA_QUEUE,
  () => handleSlaScan(engineDeps, automationQueue, gate),
  // One sweep at a time: the scan is idempotent but there is no reason to overlap it.
  { connection: duplicate(), concurrency: 1 },
);

// A repeatable job keyed by name: adding it again on every boot is a no-op.
void slaQueue.add(SLA_SCAN_JOB, {}, {
  repeat: { every: env.SLA_SCAN_INTERVAL_SECONDS * 1000 },
  jobId: 'sla-scan',
  removeOnComplete: true,
  removeOnFail: 10,
});

// A repeatable job keyed by name: adding it again on every boot is a no-op.
void analyticsQueue.add(
  'metrics-rollup',
  { organizationId: '', exportId: '' },
  {
    repeat: { every: env.METRICS_ROLLUP_INTERVAL_SECONDS * 1000 },
    jobId: 'metrics-rollup',
    removeOnComplete: true,
    removeOnFail: 10,
  },
);

const workers = [
  emailWorker,
  notificationWorker,
  automationWorker,
  slaWorker,
  channelWorker,
  webhookWorker,
  aiWorker,
  analyticsWorker,
];

for (const worker of workers) {
  worker.on('failed', (job, error) => {
    logger.error(
      { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade },
      `Job failed: ${error.message}`,
    );
  });
  worker.on('completed', (job) => {
    logger.debug({ queue: worker.name, jobId: job.id }, 'Job completed');
  });
}

logger.info(`Worker started (email provider: ${emailProvider.name})`);

/** How long in-flight jobs get to finish before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, draining queues`);

  // Orchestrators send SIGKILL after their own grace period; exit first, uncleanly if
  // a job refuses to finish, rather than be killed mid-write without a log line.
  const deadline = setTimeout(() => {
    logger.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  const settle = async (label: string, tasks: Promise<unknown>[]) => {
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn({ err: result.reason }, `Error while closing ${label}`);
      }
    }
  };

  // Workers first, so running jobs complete and nothing new is picked up.
  await settle('workers', workers.map((worker) => worker.close()));
  await settle('queues', [emailQueue, automationQueue, slaQueue, analyticsQueue].map((queue) => queue.close()));
  await settle('redis', [...connections, connection].map((client) => client.quit()));
  await settle('database', [prisma.$disconnect()]);

  clearTimeout(deadline);
  logger.info('Worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
