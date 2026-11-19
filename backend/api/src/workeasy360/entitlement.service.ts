import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  EntitlementCache,
  RedisKeyValueStore,
  UNCHECKED,
  type EntitlementAccess,
  type EntitlementLogger,
} from '@digisoft/workeasy360';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { Workeasy360ClientProvider } from './workeasy360-client.provider';
import { Workeasy360Settings } from './workeasy360.settings';

const LINK_TTL_SECONDS = 60;
const linkKey = (organizationId: string): string => `org:${organizationId}:w360`;

/**
 * Is this organization (and person) still entitled to Easy Help Desk? The API's face of the
 * shared EntitlementCache: answers are shared through Redis, and each process keeps its own
 * copy, so a Redis outage or eviction cannot hand access back to an expired organization.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger('Workeasy360Entitlement');
  private cache: EntitlementCache | null = null;

  constructor(
    private readonly clients: Workeasy360ClientProvider,
    private readonly settings: Workeasy360Settings,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Whether entitlements are checked here (Workeasy360 configured). An unusable key does not
   * switch checking off: the cache then sees an outage and keeps its last answer.
   */
  get enabled(): boolean {
    return this.settings.configured;
  }

  async check(workeasyOrganizationId: string, options: { subject?: string } = {}): Promise<EntitlementAccess> {
    const cache = this.entitlements();
    if (!cache) return UNCHECKED;
    return cache.check(workeasyOrganizationId, options);
  }

  /**
   * The Workeasy360 organization an organization is bound to, or null: remembered for a
   * minute in Redis. For requests that carry no token claims (API keys, the help center).
   */
  async linkedOrganizationId(organizationId: string): Promise<string | null> {
    const cached = await this.redis.get(linkKey(organizationId)).catch(() => null);
    if (cached !== null) return cached === '' ? null : cached;
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { workeasy360OrganizationId: true },
    });
    const id = row?.workeasy360OrganizationId ?? null;
    await this.redis.set(linkKey(organizationId), id ?? '', 'EX', LINK_TTL_SECONDS).catch(() => undefined);
    return id;
  }

  async forgetLink(organizationId: string): Promise<void> {
    await this.redis.del(linkKey(organizationId)).catch(() => undefined);
  }

  /** Forget this process's copy of the answers (tests). */
  clearLocal(): void {
    this.cache?.clearLocal();
  }

  private entitlements(): EntitlementCache | null {
    if (!this.settings.configured) return null;
    if (!this.cache) {
      // Resolved per call, so a key that becomes readable again is picked up.
      const source = {
        verifyEntitlement: (organizationId: string, options?: { subject?: string; write?: boolean }) =>
          this.clients.get().verifyEntitlement(organizationId, options),
      };
      const logger: EntitlementLogger = {
        info: (meta, message) => this.logger.log({ msg: message, ...meta }),
        warn: (meta, message) => this.logger.warn({ msg: message, ...meta }),
        error: (meta, message) => this.logger.error({ msg: message, ...meta }),
      };
      this.cache = new EntitlementCache({ source, store: new RedisKeyValueStore(this.redis), logger });
    }
    return this.cache;
  }
}
