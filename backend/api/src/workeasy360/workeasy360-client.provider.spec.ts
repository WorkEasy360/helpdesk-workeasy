import { generateKeyPairSync } from 'node:crypto';
import { Workeasy360Error } from '@digisoft/workeasy360';
import type { AppConfig } from '../config/config.module';
import { Workeasy360ClientProvider } from './workeasy360-client.provider';
import type { Workeasy360Settings } from './workeasy360.settings';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function build(options: { configured?: boolean; key: () => string; production?: boolean }) {
  const settings = {
    configured: options.configured ?? true,
    issuer: 'https://auth.example.test',
    clientId: 'c',
    redirectUri: 'https://help.example.test/cb',
    keyId: 'k',
    scopes: ['openid'],
    privateKeyPem: options.key,
  } as unknown as Workeasy360Settings;
  const config = { isProduction: options.production ?? false } as unknown as AppConfig;
  return new Workeasy360ClientProvider(settings, config);
}

const unreadable = () => {
  throw new Error('ENOENT: no such file or directory, open /run/secrets/missing.key');
};

describe('Workeasy360ClientProvider and an unusable key', () => {
  it('treats a missing key file as a misconfiguration, never a raw filesystem error', () => {
    const provider = build({ key: unreadable });
    expect(provider.tryGet()).toBeNull();
    let thrown: unknown;
    try {
      provider.get();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Workeasy360Error);
    expect((thrown as Workeasy360Error).code).toBe('provider_misconfigured');
    expect(String((thrown as Workeasy360Error).detail)).not.toContain('/run/secrets');
  });

  it('treats a key that is not a key as a misconfiguration', () => {
    expect(build({ key: () => 'not a pem' }).tryGet()).toBeNull();
  });

  it('does not read the file again on every request after a failure (retries after a pause)', () => {
    let reads = 0;
    const provider = build({
      key: () => {
        reads += 1;
        return unreadable();
      },
    });
    for (let i = 0; i < 20; i += 1) provider.tryGet();
    expect(reads).toBe(1);
  });

  it('recovers once the key is readable again', () => {
    jest.useFakeTimers();
    try {
      let good = false;
      const provider = build({ key: () => (good ? pem : unreadable()) });
      expect(provider.tryGet()).toBeNull();
      good = true;
      expect(provider.tryGet()).toBeNull(); // still inside the pause
      jest.advanceTimersByTime(31_000);
      expect(provider.tryGet()).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('builds the client once and caches it', () => {
    const provider = build({ key: () => pem });
    expect(provider.tryGet()).toBe(provider.tryGet());
  });

  it('is not an error when Workeasy360 is not configured at all', () => {
    const provider = build({ configured: false, key: unreadable });
    expect(provider.tryGet()).toBeNull();
    expect(() => provider.onModuleInit()).not.toThrow();
  });

  describe('at boot', () => {
    it('production refuses to start with an unusable key', () => {
      expect(() => build({ production: true, key: unreadable }).onModuleInit()).toThrow(Workeasy360Error);
      expect(() => build({ production: true, key: () => 'garbage' }).onModuleInit()).toThrow(Workeasy360Error);
    });

    it('production starts with a good key', () => {
      expect(() => build({ production: true, key: () => pem }).onModuleInit()).not.toThrow();
    });

    it('development starts anyway and reports the problem on first use', () => {
      const provider = build({ production: false, key: unreadable });
      expect(() => provider.onModuleInit()).not.toThrow();
      expect(provider.tryGet()).toBeNull();
    });
  });
});
