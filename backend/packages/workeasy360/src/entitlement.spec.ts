import { Workeasy360Error } from './errors';
import type { EntitlementAnswer } from './client';
import {
  EntitlementCache,
  UNCHECKED,
  type EntitlementLogger,
  type EntitlementSource,
  type KeyValueStore,
} from './entitlement';

const ORG = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const SUB = 'subject-1';

class MemoryStore implements KeyValueStore {
  data = new Map<string, { value: string; expiresAt: number | null }>();
  failing = false;
  constructor(private readonly now: () => number) {}

  async get(key: string) {
    if (this.failing) throw new Error('store down');
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: string, ttlSeconds: number | null) {
    if (this.failing) throw new Error('store down');
    this.data.set(key, { value, expiresAt: ttlSeconds === null ? null : this.now() + ttlSeconds * 1000 });
  }
  async add(key: string, ttlSeconds: number) {
    if (this.failing) throw new Error('store down');
    if ((await this.get(key)) !== null) return false;
    await this.set(key, '1', ttlSeconds);
    return true;
  }
  async del(key: string) {
    if (this.failing) throw new Error('store down');
    this.data.delete(key);
  }
  /** Simulates eviction of every answer. */
  evictAll() {
    this.data.clear();
  }
}

const allow = (extra: Partial<EntitlementAnswer> = {}): EntitlementAnswer => ({
  decision: 'allow',
  reason: 'entitled',
  writeAllowed: true,
  revalidateAfter: 900,
  ...extra,
});
const deny = (reason = 'expired'): EntitlementAnswer => ({
  decision: 'deny',
  reason,
  writeAllowed: false,
  revalidateAfter: 900,
});

function build() {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const store = new MemoryStore(clock);
  const calls: { organizationId: string; subject: string | undefined }[] = [];
  const state: { next: () => Promise<EntitlementAnswer> } = { next: async () => allow() };
  const source: EntitlementSource = {
    verifyEntitlement: async (organizationId, options) => {
      calls.push({ organizationId, subject: options?.subject });
      return state.next();
    },
  };
  const logs: { level: string; message: string; meta: Record<string, unknown> }[] = [];
  const logger: EntitlementLogger = {
    info: (meta, message) => logs.push({ level: 'info', message, meta }),
    warn: (meta, message) => logs.push({ level: 'warn', message, meta }),
    error: (meta, message) => logs.push({ level: 'error', message, meta }),
  };
  const cache = new EntitlementCache({ source, store, now: clock, logger });
  return {
    cache,
    store,
    calls,
    logs,
    state,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    reply: (answer: EntitlementAnswer) => {
      state.next = async () => answer;
    },
    fail: (code: 'provider_unavailable' | 'provider_refused' | 'rate_limited') => {
      state.next = async () => {
        throw new Workeasy360Error(code, 'scripted');
      };
    },
  };
}

describe('EntitlementCache trust windows', () => {
  it('trusts an allow for the advertised revalidate_after, then asks again', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 600 }));
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
    t.advance(599);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.advance(2);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(2);
  });

  it('never trusts an allow for more than 900 seconds, whatever is advertised', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 86_400 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(901);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(2);
  });

  it('never trusts an allow for less than 30 seconds, whatever is advertised', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 1 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(29);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.advance(2);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(2);
  });

  it('re-asks a person denial after 60 seconds, so a renewal takes effect quickly', async () => {
    const t = build();
    t.reply(deny('membership_inactive'));
    const first = await t.cache.check(ORG, { subject: SUB });
    expect(first).toMatchObject({ allowed: false, status: 'deny', reason: 'membership_inactive' });
    t.advance(59);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.reply(allow());
    t.advance(2);
    expect((await t.cache.check(ORG, { subject: SUB })).allowed).toBe(true);
    expect(t.calls).toHaveLength(2);
  });

  it('trusts a background denial for 900 seconds, not 60', async () => {
    const t = build();
    t.reply(deny('expired'));
    await t.cache.check(ORG);
    t.advance(600);
    expect((await t.cache.check(ORG)).allowed).toBe(false);
    expect(t.calls).toHaveLength(1);
    t.advance(301);
    await t.cache.check(ORG);
    expect(t.calls).toHaveLength(2);
  });

  it('keeps person answers and organization answers apart', async () => {
    const t = build();
    await t.cache.check(ORG);
    await t.cache.check(ORG, { subject: SUB });
    await t.cache.check(ORG, { subject: 'someone-else' });
    expect(t.calls).toEqual([
      { organizationId: ORG, subject: undefined },
      { organizationId: ORG, subject: SUB },
      { organizationId: ORG, subject: 'someone-else' },
    ]);
  });

  it('reports write_allowed false for a read-only allow', async () => {
    const t = build();
    t.reply(allow({ writeAllowed: false, reason: 'read_only' }));
    expect(await t.cache.check(ORG, { subject: SUB })).toMatchObject({ allowed: true, writeAllowed: false });
  });
});

describe('EntitlementCache outage handling', () => {
  it('lets access continue when there is no answer yet and the provider is down', async () => {
    const t = build();
    t.fail('provider_unavailable');
    expect(await t.cache.check(ORG, { subject: SUB })).toEqual(UNCHECKED);
    expect(t.logs.some((l) => l.message === 'workeasy360.entitlement_unavailable')).toBe(true);
  });

  it('keeps the last answer through an outage: an allow stays an allow', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 60 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    t.fail('provider_unavailable');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
  });

  it('keeps a known denial through an outage: a denial is never turned into access', async () => {
    const t = build();
    t.reply(deny());
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    t.fail('provider_unavailable');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('deny');
  });

  it('treats 429 as an outage, never a denial', async () => {
    const t = build();
    t.fail('rate_limited');
    expect(await t.cache.check(ORG, { subject: SUB })).toEqual(UNCHECKED);
  });

  it('waits 60 seconds after a failure before asking again', async () => {
    const t = build();
    t.fail('provider_unavailable');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(30);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.advance(31);
    t.reply(allow());
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
    expect(t.calls).toHaveLength(2);
  });

  it('keeps answering from its own copy when the shared store is down', async () => {
    const t = build();
    t.reply(deny());
    await t.cache.check(ORG, { subject: SUB });
    t.store.failing = true;
    t.advance(61);
    t.fail('provider_unavailable');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('deny');
  });

  it('a known denial survives eviction of the shared store', async () => {
    const t = build();
    t.reply(deny());
    await t.cache.check(ORG, { subject: SUB });
    t.store.evictAll();
    t.advance(120);
    t.fail('provider_unavailable');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('deny');
  });

  it('stores a denial with no expiry and an allow with one', async () => {
    const t = build();
    t.reply(deny());
    await t.cache.check(ORG, { subject: SUB });
    const keys = [...t.store.data.entries()];
    expect(keys).toHaveLength(1);
    expect(keys[0]![1].expiresAt).toBeNull();
    const u = build();
    await u.cache.check(ORG, { subject: SUB });
    expect([...u.store.data.values()][0]!.expiresAt).not.toBeNull();
  });
});

describe('EntitlementCache refusal of our own client', () => {
  it('fails closed with status refused, logged as an error', async () => {
    const t = build();
    t.fail('provider_refused');
    const access = await t.cache.check(ORG, { subject: SUB });
    expect(access).toMatchObject({ allowed: false, writeAllowed: false, status: 'refused', reason: 'refused' });
    expect(t.logs.some((l) => l.level === 'error' && l.message === 'workeasy360.entitlement_refused')).toBe(true);
  });

  it('re-asks every 60 seconds, and recovers when the credential is fixed', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(59);
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.reply(allow());
    t.advance(2);
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
    expect(t.calls).toHaveLength(2);
  });

  it('is not waved through when a later attempt is an outage', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    t.fail('provider_unavailable');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('refused');
  });

  it('applies to background checks too', async () => {
    const t = build();
    t.fail('provider_refused');
    expect((await t.cache.check(ORG)).status).toBe('refused');
  });
});

describe('EntitlementCache single flight', () => {
  it('asks once for concurrent first checks and answers every one of them', async () => {
    const t = build();
    let release: (answer: EntitlementAnswer) => void = () => undefined;
    t.state.next = () =>
      new Promise<EntitlementAnswer>((resolve) => {
        release = resolve;
      });
    const pending = Array.from({ length: 5 }, () => t.cache.check(ORG, { subject: SUB }));
    await new Promise((resolve) => setImmediate(resolve));
    release(deny());
    const results = await Promise.all(pending);
    expect(t.calls).toHaveLength(1);
    // A first check is never waved through because another request is asking.
    expect(results.every((r) => r.status === 'deny')).toBe(true);
  });

  it('lets others use the last answer while one request refreshes', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 60 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    let release: (answer: EntitlementAnswer) => void = () => undefined;
    t.state.next = () =>
      new Promise<EntitlementAnswer>((resolve) => {
        release = resolve;
      });
    const refresher = t.cache.check(ORG, { subject: SUB });
    await new Promise((resolve) => setImmediate(resolve));
    const other = await t.cache.check(ORG, { subject: SUB });
    expect(other.status).toBe('allow');
    expect(t.calls).toHaveLength(2);
    release(deny());
    expect((await refresher).status).toBe('deny');
  });

  it('uses the last answer when another process holds the refresh lock, but asks when it has none', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 60 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    // Another process is refreshing.
    const key = [...t.store.data.keys()][0]!;
    await t.store.add(`${key}:refreshing`, 15);
    t.reply(deny());
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
    expect(t.calls).toHaveLength(1);

    // Nothing known for this person: the first check asks even though the lock is held elsewhere.
    const fresh = build();
    fresh.reply(deny());
    await fresh.store.add('w360:ent:org:' + ORG + ':refreshing', 15);
    expect((await fresh.cache.check(ORG)).status).toBe('deny');
    expect(fresh.calls).toHaveLength(1);
  });

  it('releases the refresh lock after asking, even when asking failed', async () => {
    const t = build();
    t.fail('provider_unavailable');
    await t.cache.check(ORG, { subject: SUB });
    expect([...t.store.data.keys()].some((key) => key.endsWith(':refreshing'))).toBe(false);
  });
});

describe('EntitlementCache logging', () => {
  it('logs a change of decision once, without tokens or subjects', async () => {
    const t = build();
    t.reply(allow({ revalidateAfter: 30 }));
    await t.cache.check(ORG, { subject: SUB });
    t.advance(31);
    await t.cache.check(ORG, { subject: SUB });
    t.advance(31);
    t.reply(deny());
    await t.cache.check(ORG, { subject: SUB });
    const changes = t.logs.filter((l) => l.message === 'workeasy360.entitlement_changed');
    expect(changes.map((c) => c.meta['decision'])).toEqual(['allow', 'deny']);
    expect(JSON.stringify(t.logs)).not.toContain(SUB);
  });
});

describe('a refusal of the client is client-wide', () => {
  it('fails every other question closed without asking, person, organization and background alike', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);

    for (const options of [{ subject: 'someone-else' }, { subject: SUB }, {}]) {
      const access = await t.cache.check('another-org', options);
      expect(access).toMatchObject({ allowed: false, writeAllowed: false, status: 'refused' });
    }
    // Not one of them reached the provider.
    expect(t.calls).toHaveLength(1);
  });

  it('does not trust an allow cached before the refusal while the window is open', async () => {
    const t = build();
    await t.cache.check(ORG, { subject: SUB });
    expect(t.calls).toHaveLength(1);
    t.fail('provider_refused');
    // A different key is asked and refused...
    await t.cache.check(ORG, { subject: 'second' });
    // ...so the person with a fresh allow is closed too.
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('refused');
  });

  it('asks one question again after 60 seconds, and recovers when it is answered', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(59);
    await t.cache.check('b', { subject: 'x' });
    expect(t.calls).toHaveLength(1);

    t.advance(2);
    t.reply(allow());
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('allow');
    expect(t.calls).toHaveLength(2);
    expect((await t.cache.check('b', { subject: 'x' })).status).toBe('allow');
  });

  it('keeps failing closed when the question after the window meets an outage (the last answer is the refusal)', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    t.fail('provider_unavailable');
    expect((await t.cache.check('b', { subject: 'x' })).status).toBe('refused');
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('refused');
  });

  it('after the window only one question goes out at a time until one is answered', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    let release: (answer: EntitlementAnswer) => void = () => undefined;
    t.state.next = () =>
      new Promise<EntitlementAnswer>((resolve) => {
        release = resolve;
      });
    const pending = ['p1', 'p2', 'p3'].map((subject) => t.cache.check(ORG, { subject }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.calls).toHaveLength(2); // the refused one, plus a single probe
    t.reply(allow());
    release(allow());
    const results = await Promise.all(pending);
    expect(results.every((r) => r.status === 'allow')).toBe(true);
  });

  it('treats a 429 inside the window (or just after it) as a refusal, not an outage', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(61);
    t.fail('rate_limited');
    const access = await t.cache.check(ORG, { subject: 'later' });
    expect(access).toMatchObject({ allowed: false, status: 'refused' });
    expect(t.logs.filter((l) => l.message === 'workeasy360.entitlement_refused')).toHaveLength(2);
  });

  it('a 429 with no refusal behind it is still an outage', async () => {
    const t = build();
    t.fail('rate_limited');
    expect(await t.cache.check(ORG, { subject: SUB })).toEqual(UNCHECKED);
  });

  it('shares the refusal through the store, so another process closes too', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.cache.clearLocal(); // a second process: nothing local, the same store
    const calls = t.calls.length;
    expect((await t.cache.check('b', { subject: 'x' })).status).toBe('refused');
    expect(t.calls).toHaveLength(calls);
  });
});

describe('a 429 after a refusal (Workeasy360 limits failed client authentications)', () => {
  it('is a refusal for five minutes after the last refusal, not only during the 60 s mark', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.fail('rate_limited');
    // 4 minutes 59 seconds later: the one question after the window meets the limiter.
    t.advance(299);
    const access = await t.cache.check('b', { subject: 'x' });
    expect(access).toMatchObject({ allowed: false, status: 'refused' });
    // The cached answers do not resume: everyone is still closed.
    expect((await t.cache.check(ORG, { subject: SUB })).status).toBe('refused');
  });

  it('is an outage once five minutes have passed since the last refusal', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.advance(301);
    t.fail('rate_limited');
    t.cache.clearLocal(); // forget the in-process mark: only the store remembers
    // The store's memory of the refusal has expired by now, so this is plainly an outage.
    await t.store.del('w360:ent:client-refused-at');
    expect(await t.cache.check('b', { subject: 'x' })).toEqual(UNCHECKED);
  });

  it('a 429 with no refusal behind it is an outage, whatever else is going on', async () => {
    const t = build();
    t.fail('rate_limited');
    expect(await t.cache.check(ORG)).toEqual(UNCHECKED);
    t.advance(10_000);
    expect(await t.cache.check('c', { subject: 'y' })).toEqual(UNCHECKED);
  });

  it('is remembered across processes through the store', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.cache.clearLocal(); // another process, same store
    t.advance(120);
    t.fail('rate_limited');
    expect((await t.cache.check('b', { subject: 'x' })).status).toBe('refused');
  });

  it('each 429 taken as a refusal renews the five minutes (the limiter is still hot)', async () => {
    const t = build();
    t.fail('provider_refused');
    await t.cache.check(ORG, { subject: SUB });
    t.fail('rate_limited');
    for (let step = 0; step < 4; step += 1) {
      t.advance(200);
      expect((await t.cache.check(`o${step}`, { subject: 'x' })).status).toBe('refused');
    }
    // 800 s after the first refusal, but never 300 s after the latest mark.
  });
});
