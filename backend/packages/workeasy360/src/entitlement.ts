import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Workeasy360Error } from './errors';
import type { EntitlementAnswer } from './client';

/** An `allow` is trusted for the provider's `revalidate_after`, never longer than this. */
export const MAX_TRUST_SECONDS = 900;
/** ... and never shorter than this, whatever the provider advertises. */
export const MIN_TRUST_SECONDS = 30;
/** A person's denial (or a refusal of our own client) is re-asked this soon: a renewal takes effect quickly. */
export const PERSON_DENIAL_RECHECK_SECONDS = 60;
/** Background work's denial is re-asked this rarely: an expired organization's jobs must not cost a question a minute each. */
export const BACKGROUND_DENIAL_RECHECK_SECONDS = 900;
/** After a failed check, how long before the provider is asked again (the last answer stands meanwhile). */
export const FAILURE_BACKOFF_SECONDS = 60;
/** One process asks; the others use the last answer until it has. */
export const REFRESH_LOCK_SECONDS = 15;
/** How long a last `allow` is kept to stand in for the provider during an outage (a denial: forever). */
export const LAST_KNOWN_KEEP_SECONDS = 7 * 24 * 3600;
/** Bound on this process's own copy of the last answers. */
export const LOCAL_MAX_ENTRIES = 10_000;

/** The reason recorded when Workeasy360 refused this product's own client. */
export const REFUSED_REASON = 'refused';

/**
 * How long the whole client counts as refused after one refusal. Workeasy360's
 * client-authentication failure limiter answers 429 after a handful of failures a minute, so
 * a revoked credential would otherwise turn into "outage" answers for most people.
 */
export const CLIENT_REFUSAL_SECONDS = 60;
/**
 * A 429 this soon after the last refusal is still the refusal talking (Workeasy360 limits failed
 * client authentications), not an outage: otherwise the one question after the 60 s window
 * could meet the limiter, read as an outage, and let every cached answer resume while the
 * credential is still revoked. A 429 with no refusal in this long stays an outage.
 */
export const RATE_LIMIT_AFTER_REFUSAL_SECONDS = 300;
const CLIENT_REFUSED_KEY = 'w360:ent:client-refused';
const CLIENT_REFUSED_AT_KEY = 'w360:ent:client-refused-at';

const CLIENT_REFUSED_ACCESS: EntitlementAccess = {
  allowed: false,
  writeAllowed: false,
  reason: REFUSED_REASON,
  status: 'refused',
};

export interface EntitlementAccess {
  /** Reads are allowed. */
  allowed: boolean;
  /** Writes are allowed too (a suspended subscription is read-only). */
  writeAllowed: boolean;
  /** The provider's reason, `refused` when it refused our client, `unchecked` when no answer was ever available. */
  reason: string;
  /**
   * `allow` / `deny`: the provider's answer. `refused`: it refused our client (fail closed).
   * `unchecked`: no answer yet and the provider could not be asked (an outage never denies).
   */
  status: 'allow' | 'deny' | 'refused' | 'unchecked';
}

export const UNCHECKED: EntitlementAccess = {
  allowed: true,
  writeAllowed: true,
  reason: 'unchecked',
  status: 'unchecked',
};

/** The shared place answers live: Redis in production, a Map in tests. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` null: no expiry (a known denial must never lapse). */
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  /** Sets only if absent. false: someone else holds it. */
  add(key: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export class RedisKeyValueStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    if (ttlSeconds === null) {
      await this.redis.set(key, value);
    } else {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    }
  }

  async add(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

export interface EntitlementSource {
  verifyEntitlement(
    organizationId: string,
    options?: { subject?: string; write?: boolean },
  ): Promise<EntitlementAnswer>;
}

export interface EntitlementLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

const silent: EntitlementLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Record_ {
  d: 'allow' | 'deny';
  r: string;
  w: boolean;
  /** Epoch milliseconds when the provider answered. */
  at: number;
  /** Seconds this answer is trusted. */
  fresh: number;
}

export interface EntitlementCacheOptions {
  source: EntitlementSource;
  store: KeyValueStore;
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
  logger?: EntitlementLogger;
}

export interface CheckOptions {
  /**
   * The `sub` the person signed in with: a person's request. Omit it for background work,
   * which has no person.
   */
  subject?: string;
}

/**
 * Is this organization (and person) still entitled to the product? Asked of Workeasy360 on
 * a cadence, never assumed (completion design section 4).
 *
 * - An `allow` is trusted for `min(revalidate_after, 900)` seconds, at least 30.
 * - A person's denial is re-asked after 60 s (a renewal takes effect quickly); background
 *   work's denial after 900 s.
 * - An outage (5xx, 429, timeout, network, misconfigured discovery, unreadable key) is never
 *   a denial: the last answer stands; with none, access continues; the next attempt waits 60 s.
 * - A refusal of our own client (400/401/403) is not an outage: fail closed (`refused`),
 *   re-asked every 60 s, logged as an error.
 * - A known denial never lapses into access: it is kept without expiry in the shared store
 *   and in this process's own copy, so a store outage or eviction cannot hand access back.
 * - Single flight: within a process one request asks and the rest wait for its answer when
 *   they have none, or use the last answer when they do. Across processes a lock does the same,
 *   but a first check is never waved through because another process happens to be asking.
 */
export class EntitlementCache {
  private readonly source: EntitlementSource;
  private readonly store: KeyValueStore;
  private readonly now: () => number;
  private readonly log: EntitlementLogger;

  // This process's copy of the last answers and of its failure back-offs: the shared store's
  // stand-in when it is down or has evicted an entry.
  private readonly local = new Map<string, Record_>();
  private readonly backoff = new Map<string, number>();
  private readonly flights = new Map<string, Promise<EntitlementAccess>>();
  /** When this process last saw (or learned of) a refusal of the client; 0: none. */
  private refusedAt = 0;
  /** A refusal was seen and no later question has been answered: one question at a time. */
  private recovering = false;
  private probe: Promise<void> | null = null;

  constructor(options: EntitlementCacheOptions) {
    this.source = options.source;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silent;
  }

  async check(workeasyOrganizationId: string, options: CheckOptions = {}): Promise<EntitlementAccess> {
    const person = Boolean(options.subject);
    const key = cacheKey(workeasyOrganizationId, options.subject);
    const now = this.now();
    // Workeasy360 refused this product's own client a moment ago: every question - person,
    // organization, background - fails closed without asking, until the window lapses.
    if (await this.clientRefused(now)) return CLIENT_REFUSED_ACCESS;
    const known = await this.lastKnown(key);

    // An answer older than the last refusal predates it and is not trusted as fresh.
    if (known && now - known.at < known.fresh * 1000 && known.at >= this.refusedAt) return toAccess(known);
    if (await this.isBackingOff(key, now)) {
      // The provider failed a moment ago: the last answer stands, or (none yet) access continues.
      return this.recovering ? CLIENT_REFUSED_ACCESS : known ? toAccess(known) : UNCHECKED;
    }

    const flight = this.flights.get(key);
    if (flight) {
      // Another request in this process is asking. Use the last answer if there is one;
      // a first check is never waved through, so wait for the answer.
      return known ? toAccess(known) : flight;
    }

    const started = this.askOnce(workeasyOrganizationId, options, person, key, known, now).finally(() => {
      this.flights.delete(key);
    });
    this.flights.set(key, started);
    return started;
  }

  /**
   * After a refusal, questions are asked one at a time until one is answered: the first goes
   * out alone (the "one question" after the window), the others wait for its result and are
   * then decided again.
   */
  private async askOnce(
    workeasyOrganizationId: string,
    options: CheckOptions,
    person: boolean,
    key: string,
    known: Record_ | null,
    now: number,
  ): Promise<EntitlementAccess> {
    if (!this.recovering) return this.ask(workeasyOrganizationId, options.subject, person, key, known, now);
    if (this.probe) {
      await this.probe;
      // This call is its own flight for the key; step aside so the fresh decision can register its own.
      this.flights.delete(key);
      return this.check(workeasyOrganizationId, options);
    }
    let finished: () => void = () => undefined;
    this.probe = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      return await this.ask(workeasyOrganizationId, options.subject, person, key, known, now);
    } finally {
      this.probe = null;
      finished();
    }
  }

  private async ask(
    workeasyOrganizationId: string,
    subject: string | undefined,
    person: boolean,
    key: string,
    known: Record_ | null,
    now: number,
  ): Promise<EntitlementAccess> {
    // True: this process asks. False: another one is asking; use the last answer if there is
    // one, and ask too if there is none. A store error: ask.
    const lockKey = `${key}:refreshing`;
    let locked = false;
    try {
      locked = await this.store.add(lockKey, REFRESH_LOCK_SECONDS);
      if (!locked && known) return toAccess(known);
    } catch {
      locked = false;
    }

    try {
      const answer = await this.source.verifyEntitlement(workeasyOrganizationId, {
        ...(subject ? { subject } : {}),
        write: false,
      });
      const record: Record_ = {
        d: answer.decision,
        r: answer.reason.slice(0, 64),
        w: answer.decision === 'allow' && answer.writeAllowed,
        at: now,
        fresh: trustSeconds(answer, person),
      };
      await this.remember(key, record);
      this.recovering = false;
      if (!known || known.d !== record.d || known.r !== record.r) {
        this.log.info(
          { organizationId: workeasyOrganizationId, decision: record.d, reason: record.r, person },
          'workeasy360.entitlement_changed',
        );
      }
      return toAccess(record);
    } catch (error) {
      const rateLimitedByRefusal =
        error instanceof Workeasy360Error &&
        error.code === 'rate_limited' &&
        now - (await this.lastRefusalAt()) < RATE_LIMIT_AFTER_REFUSAL_SECONDS * 1000;
      if ((error instanceof Workeasy360Error && error.code === 'provider_refused') || rateLimitedByRefusal) {
        // Workeasy360 answered and refused our own client (or its limiter, fed by that refusal,
        // is answering 429): not an outage. The whole client fails closed, loudly.
        this.log.error(
          {
            organizationId: workeasyOrganizationId,
            detail: error instanceof Workeasy360Error ? error.detail : '',
            rateLimited: rateLimitedByRefusal,
          },
          'workeasy360.entitlement_refused',
        );
        await this.markClientRefused(now);
        return CLIENT_REFUSED_ACCESS;
      }
      // An outage: never a denial. (An unreadable key or a broken reply is logged by type only.)
      this.log.warn(
        {
          organizationId: workeasyOrganizationId,
          code: error instanceof Workeasy360Error ? error.code : error instanceof Error ? error.name : 'unknown',
          detail: error instanceof Workeasy360Error ? error.detail : '',
          lastKnown: known?.d ?? null,
        },
        'workeasy360.entitlement_unavailable',
      );
      await this.backOff(key, now);
      // After a refusal the last answer for the client is the refusal, until a question is answered.
      return this.recovering ? CLIENT_REFUSED_ACCESS : known ? toAccess(known) : UNCHECKED;
    } finally {
      if (locked) await this.store.del(lockKey).catch(() => undefined);
    }
  }

  private async clientRefused(now: number): Promise<boolean> {
    if (this.refusedAt > 0 && now - this.refusedAt < CLIENT_REFUSAL_SECONDS * 1000) return true;
    try {
      const raw = await this.store.get(CLIENT_REFUSED_KEY);
      if (raw) {
        const at = Number(raw);
        if (Number.isFinite(at) && at > this.refusedAt) {
          // Another process learned of it: so did this one.
          this.refusedAt = at;
          this.recovering = true;
        }
        if (Number.isFinite(at) && now - at < CLIENT_REFUSAL_SECONDS * 1000) return true;
      }
    } catch {
      // The local copy decides.
    }
    return false;
  }

  /** When the client was last refused, by this process or (through the store) another one; 0: not within the memory. */
  private async lastRefusalAt(): Promise<number> {
    let at = this.refusedAt;
    try {
      const raw = await this.store.get(CLIENT_REFUSED_AT_KEY);
      const stored = raw ? Number(raw) : 0;
      if (Number.isFinite(stored) && stored > at) at = stored;
    } catch {
      // The local copy decides.
    }
    return at > 0 ? at : -Infinity;
  }

  private async markClientRefused(now: number): Promise<void> {
    this.refusedAt = now;
    this.recovering = true;
    try {
      await this.store.set(CLIENT_REFUSED_AT_KEY, String(now), RATE_LIMIT_AFTER_REFUSAL_SECONDS);
      await this.store.set(CLIENT_REFUSED_KEY, String(now), CLIENT_REFUSAL_SECONDS);
    } catch {
      // The local copy stands in.
    }
  }

  /** Forget this process's copy of the answers (tests; the shared store is cleared separately). */
  clearLocal(): void {
    this.local.clear();
    this.backoff.clear();
    this.flights.clear();
    this.refusedAt = 0;
    this.recovering = false;
    this.probe = null;
  }

  private async lastKnown(key: string): Promise<Record_ | null> {
    let shared: Record_ | null = null;
    try {
      const raw = await this.store.get(key);
      if (raw) shared = JSON.parse(raw) as Record_;
    } catch {
      shared = null;
    }
    const local = this.local.get(key) ?? null;
    if (shared && local) return local.at > shared.at ? local : shared;
    return shared ?? local;
  }

  private async remember(key: string, record: Record_): Promise<void> {
    try {
      await this.store.set(key, JSON.stringify(record), record.d === 'allow' ? LAST_KNOWN_KEEP_SECONDS : null);
    } catch {
      // The local copy below stands in.
    }
    this.local.delete(key);
    this.local.set(key, record);
    while (this.local.size > LOCAL_MAX_ENTRIES) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    this.backoff.delete(key);
  }

  private async isBackingOff(key: string, now: number): Promise<boolean> {
    if ((this.backoff.get(key) ?? 0) > now) return true;
    try {
      return (await this.store.get(`${key}:backoff`)) !== null;
    } catch {
      return false;
    }
  }

  private async backOff(key: string, now: number): Promise<void> {
    this.backoff.set(key, now + FAILURE_BACKOFF_SECONDS * 1000);
    try {
      await this.store.set(`${key}:backoff`, '1', FAILURE_BACKOFF_SECONDS);
    } catch {
      // The local back-off stands in.
    }
  }
}

function cacheKey(workeasyOrganizationId: string, subject?: string): string {
  if (!subject) return `w360:ent:org:${workeasyOrganizationId}`;
  const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
  return `w360:ent:sub:${workeasyOrganizationId}:${digest}`;
}

function trustSeconds(answer: EntitlementAnswer, person: boolean): number {
  if (answer.decision !== 'allow') {
    return person ? PERSON_DENIAL_RECHECK_SECONDS : BACKGROUND_DENIAL_RECHECK_SECONDS;
  }
  return Math.max(MIN_TRUST_SECONDS, Math.min(Math.floor(answer.revalidateAfter), MAX_TRUST_SECONDS));
}

function toAccess(record: Record_): EntitlementAccess {
  if (record.d === 'allow') {
    return { allowed: true, writeAllowed: record.w, reason: record.r, status: 'allow' };
  }
  return {
    allowed: false,
    writeAllowed: false,
    reason: record.r,
    status: record.r === REFUSED_REASON ? 'refused' : 'deny',
  };
}
