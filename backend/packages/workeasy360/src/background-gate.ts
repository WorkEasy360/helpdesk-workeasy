import {
  BACKGROUND_DENIAL_RECHECK_SECONDS,
  PERSON_DENIAL_RECHECK_SECONDS,
  type EntitlementCache,
  type EntitlementLogger,
} from './entitlement';

/** What the gate needs from a Prisma client: the organization's Workeasy360 binding. */
export interface OrganizationLinkSource {
  organization: {
    findUnique(args: {
      where: { id: string };
      select: { workeasy360OrganizationId: true };
    }): Promise<{ workeasy360OrganizationId: string | null } | null>;
  };
}

export interface BackgroundGateOptions {
  prisma: OrganizationLinkSource;
  /** Null when Workeasy360 is not configured here: nothing is checked. */
  entitlements: EntitlementCache | null;
  logger?: EntitlementLogger;
  now?: () => number;
}

export interface BackgroundDecision {
  allowed: boolean;
  /** Why it was denied (the provider's reason, `refused` when our client was refused). */
  reason?: string;
}

/** How long an organization's Workeasy360 binding is remembered by a worker process. */
export const LINK_CACHE_SECONDS = 60;

/**
 * Class A background work (completion design section 5): before a job produces a customer
 * business effect it asks whether the organization still holds the product, at the
 * organization level (no person) and with writes allowed. A denial skips the effect; the
 * caller logs `workeasy360.background_skipped` through `skipped()` and completes the job
 * without throwing, so a denied organization does not become a retry loop.
 *
 * Only organizations bound to Workeasy360 are checked: a product-only organization has no
 * Workeasy360 entitlement to lose. An outage never denies (the cache keeps the last answer,
 * and with none, work continues).
 */
export class BackgroundGate {
  private readonly prisma: OrganizationLinkSource;
  private readonly entitlements: EntitlementCache | null;
  private readonly log: EntitlementLogger | undefined;
  private readonly now: () => number;
  private readonly links = new Map<string, { id: string | null; at: number }>();
  /** Organizations whose denial is known, until when it is trusted (then they are asked again). */
  private readonly denied = new Map<string, number>();
  /** The reason last logged as skipped, per organization: a sweep logs a denial once, not every minute. */
  private readonly announced = new Map<string, string>();

  constructor(options: BackgroundGateOptions) {
    this.prisma = options.prisma;
    this.entitlements = options.entitlements;
    this.log = options.logger;
    this.now = options.now ?? Date.now;
  }

  async check(organizationId: string): Promise<BackgroundDecision> {
    if (!this.entitlements) return { allowed: true };
    const linked = await this.linkedId(organizationId);
    if (!linked) return { allowed: true };
    const access = await this.entitlements.check(linked);
    if (access.allowed && access.writeAllowed) {
      this.denied.delete(organizationId);
      this.announced.delete(organizationId);
      return { allowed: true };
    }
    const recheck = access.status === 'refused' ? PERSON_DENIAL_RECHECK_SECONDS : BACKGROUND_DENIAL_RECHECK_SECONDS;
    this.denied.set(organizationId, this.now() + recheck * 1000);
    return { allowed: false, reason: access.allowed ? 'read_only' : access.reason };
  }

  /**
   * Organizations known to be denied right now. A scan that reads many organizations' rows
   * leaves these out of its query instead of loading their work every sweep; an entry expires
   * when the denial is due to be asked again, so a renewal is noticed.
   */
  deniedOrganizations(): string[] {
    const now = this.now();
    const ids: string[] = [];
    for (const [id, until] of this.denied) {
      if (until > now) ids.push(id);
      else this.denied.delete(id);
    }
    return ids;
  }

  /**
   * Checks, and when denied logs the skip. Returns true when the effect may be produced.
   * `job` names what was about to happen (`automation`, `channel-send`, ...).
   */
  async allows(organizationId: string, job: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const decision = await this.check(organizationId);
    if (!decision.allowed) this.skipped(organizationId, job, decision.reason ?? 'denied', extra);
    return decision.allowed;
  }

  skipped(organizationId: string, job: string, reason: string, extra: Record<string, unknown> = {}): void {
    this.log?.warn({ organizationId, job, reason, ...extra }, 'workeasy360.background_skipped');
  }

  /**
   * A per-sweep memo for jobs that scan many organizations at once (the SLA scan): each
   * distinct organization is checked once per sweep, however many tickets it has.
   */
  sweep(job: string): (organizationId: string) => Promise<boolean> {
    const decided = new Map<string, Promise<boolean>>();
    return (organizationId) => {
      let verdict = decided.get(organizationId);
      if (!verdict) {
        verdict = this.check(organizationId).then((decision) => {
          if (decision.allowed) return true;
          const reason = decision.reason ?? 'denied';
          // A denial is announced when it begins or changes, not on every sweep.
          if (this.announced.get(organizationId) !== reason) {
            this.announced.set(organizationId, reason);
            this.skipped(organizationId, job, reason);
          }
          return false;
        });
        decided.set(organizationId, verdict);
      }
      return verdict;
    };
  }

  private async linkedId(organizationId: string): Promise<string | null> {
    const cached = this.links.get(organizationId);
    const now = this.now();
    if (cached && now - cached.at < LINK_CACHE_SECONDS * 1000) return cached.id;
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { workeasy360OrganizationId: true },
    });
    const id = row?.workeasy360OrganizationId ?? null;
    this.links.set(organizationId, { id, at: now });
    return id;
  }
}
