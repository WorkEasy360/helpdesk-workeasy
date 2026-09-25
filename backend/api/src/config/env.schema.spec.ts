import { validateEnv, webhookBodyLimit } from './env.schema';

describe('environment validation', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/app',
    JWT_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    FRONTEND_URL: 'https://desk.example.com',
    BACKEND_URL: 'https://api.example.com',
    COOKIE_SECURE: 'true',
    EMAIL_PROVIDER: 'smtp',
    CHANNEL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('accepts a sound production configuration', () => {
    const env = validateEnv(production);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.ALLOW_PUBLIC_REGISTRATION).toBe(true);
  });

  it.each([
    [{ COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
    [{ FRONTEND_URL: 'http://localhost:3000' }, /FRONTEND_URL/],
    [{ BACKEND_URL: 'http://127.0.0.1:4000' }, /BACKEND_URL/],
    [{ EMAIL_PROVIDER: 'console' }, /EMAIL_PROVIDER/],
    [{ CHANNEL_ENCRYPTION_KEY: undefined }, /CHANNEL_ENCRYPTION_KEY/],
    [{ JWT_SECRET: 'replace-me-with-at-least-32-characters-of-random-data' }, /JWT_SECRET/],
    [{ JWT_REFRESH_SECRET: 'a'.repeat(48) }, /must differ/],
    [{ EMAIL_PROVIDER: 'ses' }, /AWS_REGION/],
  ])('refuses %j', (override, message) => {
    expect(() => validateEnv({ ...production, ...override })).toThrow(message);
  });

  it('keeps development permissive', () => {
    expect(() =>
      validateEnv({ ...production, NODE_ENV: 'development', COOKIE_SECURE: 'false', EMAIL_PROVIDER: 'console' }),
    ).not.toThrow();
  });

  it('parses TRUST_PROXY into what express expects', () => {
    expect(validateEnv({ ...production, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(validateEnv({ ...production, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(validateEnv(production).TRUST_PROXY).toBe('loopback, linklocal, uniquelocal');
  });

  it('sizes the webhook body limit from the attachment ceiling', () => {
    expect(webhookBodyLimit({ WEBHOOK_BODY_LIMIT: undefined, ATTACHMENT_MAX_BYTES: 10_000_000 })).toBe(
      14_000_000 + 1024 * 1024,
    );
    expect(webhookBodyLimit({ WEBHOOK_BODY_LIMIT: '50mb', ATTACHMENT_MAX_BYTES: 1 })).toBe('50mb');
  });
});
