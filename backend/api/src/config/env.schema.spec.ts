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
    // Production signs agents in through Workeasy360 unless that is explicitly switched off.
    WORKEASY360_ISSUER: 'https://app.workeasy360.com',
    WORKEASY360_CLIENT_ID: 'client-abc',
    WORKEASY360_REDIRECT_URI: 'https://desk.example.com/api/auth/callback/workeasy360',
    WORKEASY360_KEY_ID: 'key-1',
    WORKEASY360_PRIVATE_KEY: 'unused-in-this-test',
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

  describe('Workeasy360 sign-in', () => {
    it('defaults to SSO-only in production and not elsewhere', () => {
      expect(validateEnv(production).WORKEASY360_SSO_ONLY).toBe(true);
      expect(validateEnv({ ...production, WORKEASY360_SSO_ONLY: 'false' }).WORKEASY360_SSO_ONLY).toBe(false);
      expect(validateEnv({ DATABASE_URL: 'postgresql://u:p@db/x', JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40) }).WORKEASY360_SSO_ONLY).toBe(false);
      expect(validateEnv({ ...production, NODE_ENV: 'test', COOKIE_SECURE: 'false', EMAIL_PROVIDER: 'console' }).WORKEASY360_SSO_ONLY).toBe(false);
    });

    it('accepts 1, true, yes and on for the switch, and treats an empty value as unset', () => {
      for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
        expect(validateEnv({ ...production, WORKEASY360_SSO_ONLY: value }).WORKEASY360_SSO_ONLY).toBe(true);
      }
      expect(validateEnv({ ...production, WORKEASY360_SSO_ONLY: '' }).WORKEASY360_SSO_ONLY).toBe(true);
      expect(validateEnv({ ...production, WORKEASY360_SSO_ONLY: '0' }).WORKEASY360_SSO_ONLY).toBe(false);
    });

    it.each([
      ['WORKEASY360_ISSUER'],
      ['WORKEASY360_CLIENT_ID'],
      ['WORKEASY360_REDIRECT_URI'],
      ['WORKEASY360_KEY_ID'],
      ['WORKEASY360_PRIVATE_KEY'],
    ])('refuses to start SSO-only without %s', (name) => {
      expect(() => validateEnv({ ...production, [name]: undefined })).toThrow(/WORKEASY360_SSO_ONLY/);
      expect(() => validateEnv({ ...production, [name]: '' })).toThrow(/WORKEASY360_SSO_ONLY/);
    });

    it('takes the key from a file instead of inline', () => {
      expect(() =>
        validateEnv({ ...production, WORKEASY360_PRIVATE_KEY: undefined, WORKEASY360_PRIVATE_KEY_FILE: '/run/secrets/w360.key' }),
      ).not.toThrow();
    });

    it('refuses SSO-only in development too: a locked door is a locked door', () => {
      expect(() =>
        validateEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@db/x', JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), WORKEASY360_SSO_ONLY: 'true' }),
      ).toThrow(/WORKEASY360_ISSUER/);
    });

    it('wants https for the issuer, redirect URI and post-logout URI in production', () => {
      expect(() => validateEnv({ ...production, WORKEASY360_ISSUER: 'http://app.workeasy360.com' })).toThrow(/WORKEASY360_ISSUER/);
      expect(() => validateEnv({ ...production, WORKEASY360_REDIRECT_URI: 'http://desk.example.com/cb' })).toThrow(/WORKEASY360_REDIRECT_URI/);
      expect(() =>
        validateEnv({ ...production, WORKEASY360_POST_LOGOUT_REDIRECT_URI: 'http://desk.example.com/login' }),
      ).toThrow(/WORKEASY360_POST_LOGOUT_REDIRECT_URI/);
    });

    it('defaults the product code, scopes and role, and never allows SUPER_ADMIN as the default role', () => {
      const env = validateEnv(production);
      expect(env.WORKEASY360_PRODUCT_CODE).toBe('easy_helpdesk');
      expect(env.WORKEASY360_SCOPES).toBe('openid email profile organization');
      expect(env.WORKEASY360_DEFAULT_ROLE).toBe('AGENT');
      expect(() => validateEnv({ ...production, WORKEASY360_DEFAULT_ROLE: 'SUPER_ADMIN' })).toThrow();
      expect(() => validateEnv({ ...production, WORKEASY360_DEFAULT_ROLE: 'CUSTOMER' })).toThrow();
      expect(validateEnv({ ...production, WORKEASY360_DEFAULT_ROLE: 'LIGHT_AGENT' }).WORKEASY360_DEFAULT_ROLE).toBe('LIGHT_AGENT');
    });

    it('does not insist on a configuration when SSO is off and nothing is set', () => {
      expect(() => validateEnv({ ...production, WORKEASY360_SSO_ONLY: 'false', WORKEASY360_ISSUER: undefined, WORKEASY360_CLIENT_ID: undefined, WORKEASY360_REDIRECT_URI: undefined, WORKEASY360_KEY_ID: undefined, WORKEASY360_PRIVATE_KEY: undefined })).not.toThrow();
    });

    it('rejects a half-set client when SSO is optional', () => {
      expect(() =>
        validateEnv({ ...production, WORKEASY360_SSO_ONLY: 'false', WORKEASY360_REDIRECT_URI: undefined }),
      ).toThrow(/WORKEASY360_REDIRECT_URI/);
    });
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
