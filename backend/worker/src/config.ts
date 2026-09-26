import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

/** Optional string where an empty value (`S3_ENDPOINT=` in an env file) means unset. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // Interactive transaction limits; raise for a database far from the app host.
  DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_TRANSACTION_MAX_WAIT_MS: z.coerce.number().int().positive().default(10_000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  /** How often the SLA sweep runs. Warnings and breaches are detected to this resolution. */
  SLA_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),

  EMAIL_PROVIDER: z.enum(['smtp', 'ses', 'console']).default('console'),
  EMAIL_FROM: z.string().default('Digisoft360 Help Desk <no-reply@digisoft360.local>'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: bool.default(false),
  AWS_REGION: optionalString,

  /** Same key the API uses; required to decrypt channel credentials when sending. */
  CHANNEL_ENCRYPTION_KEY: optionalString,
  /** Attempts per outbound webhook delivery before it is marked failed. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /** Where report exports are written. Must match the API, or downloads 404. */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  S3_ENDPOINT: optionalString,
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  /** Virtual-hosted addressing (AWS S3) by default; MinIO and most S3 clones need true. */
  S3_FORCE_PATH_STYLE: bool.default(false),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(300),
  /** How often the metric rollup sweep runs. */
  METRICS_ROLLUP_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  /** How many recent days each sweep recomputes. */
  METRICS_ROLLUP_DAYS: z.coerce.number().int().min(1).max(31).default(2),
});

export type WorkerEnv = z.infer<typeof schema>;

/** Settings that are fine in development and wrong in production; refused at boot. */
export function productionIssues(env: WorkerEnv): string[] {
  const issues: string[] = [];
  if (env.EMAIL_PROVIDER === 'ses' && !env.AWS_REGION) {
    issues.push('AWS_REGION: required when EMAIL_PROVIDER=ses');
  }
  if (env.NODE_ENV !== 'production') {
    return issues;
  }
  if (env.EMAIL_PROVIDER === 'console') {
    issues.push('EMAIL_PROVIDER: console only logs mail; use smtp or ses in production');
  }
  if (!env.CHANNEL_ENCRYPTION_KEY) {
    issues.push('CHANNEL_ENCRYPTION_KEY: required in production (same key as the API)');
  }
  return issues;
}

export function loadEnv(source: Record<string, unknown> = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid worker environment:\n${issues.join('\n')}`);
  }
  const unsafe = productionIssues(parsed.data);
  if (unsafe.length > 0) {
    throw new Error(`Invalid worker environment:\n${unsafe.map((i) => `  - ${i}`).join('\n')}`);
  }
  return parsed.data;
}
