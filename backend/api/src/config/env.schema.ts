import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

/** Optional string where an empty value (`S3_ENDPOINT=` in an env file) means unset. */
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('api/v1'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  BACKEND_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(30),

  COOKIE_DOMAIN: optionalString,
  COOKIE_SECURE: bool.default(false),

  /**
   * Express `trust proxy`: which hops may set X-Forwarded-For/-Proto, and so decide
   * `req.ip` (rate limits, audit) and `req.protocol` (Twilio signature URLs). A hop
   * count (`1`), `true`, `false`, or a comma-separated list of addresses, CIDRs and the
   * names `loopback`, `linklocal`, `uniquelocal`. The default trusts proxies on private
   * networks — a reverse proxy container or a load balancer inside the VPC.
   */
  TRUST_PROXY: z
    .string()
    .default('loopback, linklocal, uniquelocal')
    .transform((v): boolean | number | string => {
      const value = v.trim();
      if (value === 'true') return true;
      if (value === 'false') return false;
      return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
    }),

  /** Request body ceiling for JSON and form posts, e.g. `1mb`. */
  BODY_LIMIT: z.string().default('1mb'),
  /**
   * Body ceiling for inbound channel webhooks, which may carry base64 attachments.
   * Defaults to ATTACHMENT_MAX_BYTES plus base64 overhead.
   */
  WEBHOOK_BODY_LIMIT: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  /** When false, `POST /auth/register` (creating a new organization) is refused. */
  ALLOW_PUBLIC_REGISTRATION: bool.default(true),

  /** Disabled only by the e2e harness so suites can replay the same route. */
  THROTTLE_ENABLED: bool.default(true),
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** A single workspace navigation fans out to several endpoints, so this is per
   * user-minute rather than per page view. */
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(300),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(10),

  EMAIL_PROVIDER: z.enum(['smtp', 'ses', 'console']).default('console'),
  EMAIL_FROM: z.string().default('Digisoft360 Help Desk <no-reply@digisoft360.local>'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: bool.default(false),
  AWS_REGION: optionalString,

  /** `local` writes to disk and streams downloads through the API; `s3` presigns. */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(300),
  /** Hard ceiling on a single upload, in bytes. */
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  /** Virtual-hosted addressing (AWS S3) by default; MinIO and most S3 clones need true. */
  S3_FORCE_PATH_STYLE: bool.default(false),

  /**
   * 32 bytes, base64 or hex, used to encrypt channel credentials at rest. Required
   * before a channel can store credentials; generate with `openssl rand -base64 32`.
   */
  CHANNEL_ENCRYPTION_KEY: optionalString,
  /** Public base URL providers post webhooks to; defaults to BACKEND_URL. */
  PUBLIC_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** Retry budget for one outbound webhook delivery before it is marked failed. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
});

export type Env = z.infer<typeof envSchema>;

/** Values shipped in `.env.example`; a production secret must never be one of them. */
const PLACEHOLDER_SECRET = /replace-me|change-?me|test-(jwt|refresh)-secret/i;

function isLocalUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Settings that are convenient in development and dangerous in production. Checked
 * here, at boot, so a misconfigured deployment refuses to start instead of running
 * with insecure cookies or mail that goes nowhere.
 */
export function productionIssues(env: Env): string[] {
  const issues: string[] = [];
  if (env.EMAIL_PROVIDER === 'ses' && !env.AWS_REGION) {
    issues.push('AWS_REGION: required when EMAIL_PROVIDER=ses');
  }
  if (env.NODE_ENV !== 'production') {
    return issues;
  }
  if (!env.COOKIE_SECURE) {
    issues.push('COOKIE_SECURE: must be true in production (cookies would be sent over plain HTTP)');
  }
  for (const key of ['FRONTEND_URL', 'BACKEND_URL', 'PUBLIC_API_URL'] as const) {
    if (isLocalUrl(env[key])) {
      issues.push(`${key}: must be the public URL in production, not localhost`);
    }
  }
  if (env.EMAIL_PROVIDER === 'console') {
    issues.push('EMAIL_PROVIDER: console only logs mail; use smtp or ses in production');
  }
  if (!env.CHANNEL_ENCRYPTION_KEY) {
    issues.push('CHANNEL_ENCRYPTION_KEY: required in production (openssl rand -base64 32)');
  }
  if (PLACEHOLDER_SECRET.test(env.JWT_SECRET)) {
    issues.push('JWT_SECRET: still the example placeholder; generate a random secret');
  }
  if (PLACEHOLDER_SECRET.test(env.JWT_REFRESH_SECRET)) {
    issues.push('JWT_REFRESH_SECRET: still the example placeholder; generate a random secret');
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    issues.push('JWT_REFRESH_SECRET: must differ from JWT_SECRET');
  }
  return issues;
}

/** ATTACHMENT_MAX_BYTES as base64 (4/3) plus room for the rest of the payload. */
export function webhookBodyLimit(env: Pick<Env, 'WEBHOOK_BODY_LIMIT' | 'ATTACHMENT_MAX_BYTES'>): string | number {
  return env.WEBHOOK_BODY_LIMIT ?? Math.ceil(env.ATTACHMENT_MAX_BYTES * 1.4) + 1024 * 1024;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const unsafe = productionIssues(parsed.data);
  if (unsafe.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${unsafe.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }
  return parsed.data;
}
