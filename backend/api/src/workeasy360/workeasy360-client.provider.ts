import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createPrivateKey } from 'node:crypto';
import { Workeasy360Client, Workeasy360Error } from '@digisoft/workeasy360';
import { AppConfig } from '../config/config.module';
import { Workeasy360Settings } from './workeasy360.settings';

/** After a failed build (an unreadable key) the next attempt waits this long. */
const RETRY_AFTER_FAILURE_MS = 30_000;

/**
 * One OpenID client per process, so discovery and the key set are cached across requests.
 * Built lazily: a deployment that does not use Workeasy360 never reads a key.
 *
 * A key that cannot be read or parsed is a misconfiguration, never a 500: callers get a
 * `provider_misconfigured` error, which the sign-in routes show as "unavailable" and the
 * entitlement cache treats like an outage (the last answer stands). In production the key is
 * loaded at boot, so the deployment refuses to start with a broken key instead.
 */
@Injectable()
export class Workeasy360ClientProvider implements OnModuleInit {
  private readonly logger = new Logger(Workeasy360ClientProvider.name);
  private client: Workeasy360Client | null = null;
  private failedAt = 0;

  constructor(
    private readonly settings: Workeasy360Settings,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.isProduction && this.settings.configured) {
      this.build(); // throws: a production deployment with an unusable key does not start
    }
  }

  /** The configured client, or null when Workeasy360 is not configured here or its key is unusable. */
  tryGet(): Workeasy360Client | null {
    if (!this.settings.configured) return null;
    if (this.client) return this.client;
    if (this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_FAILURE_MS) return null;
    try {
      return this.build();
    } catch (error) {
      this.failedAt = Date.now();
      this.logger.error({
        msg: 'workeasy360.client_unavailable',
        detail: error instanceof Workeasy360Error ? error.detail : 'the client key could not be loaded',
      });
      return null;
    }
  }

  /** The client, or a `provider_misconfigured` error (never a raw filesystem or crypto error). */
  get(): Workeasy360Client {
    const client = this.tryGet();
    if (!client) throw new Workeasy360Error('provider_misconfigured', 'Workeasy360 sign-in is not configured or its key is unusable');
    return client;
  }

  private build(): Workeasy360Client {
    let pem: string;
    try {
      pem = this.settings.privateKeyPem();
      createPrivateKey(pem);
    } catch {
      throw new Workeasy360Error('provider_misconfigured', 'the client private key is missing or unreadable');
    }
    this.client = new Workeasy360Client({
      issuer: this.settings.issuer,
      clientId: this.settings.clientId,
      redirectUri: this.settings.redirectUri,
      keyId: this.settings.keyId,
      privateKeyPem: pem,
      scopes: this.settings.scopes,
      requireHttps: this.config.isProduction,
    });
    this.failedAt = 0;
    return this.client;
  }
}
