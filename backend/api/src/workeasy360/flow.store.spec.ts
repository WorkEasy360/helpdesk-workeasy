import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { FLOW_TTL_SECONDS, FlowStore } from './flow.store';

class FakeRedis {
  data = new Map<string, { value: string; ttl: number | undefined }>();
  async set(key: string, value: string, mode?: string, ttl?: number) {
    this.data.set(key, { value, ttl: mode === 'EX' ? ttl : undefined });
    return 'OK';
  }
  async getdel(key: string) {
    const entry = this.data.get(key);
    this.data.delete(key);
    return entry?.value ?? null;
  }
}

function build() {
  let now = 1_700_000_000_000;
  const redis = new FakeRedis();
  const store = new FlowStore(redis as unknown as Redis, () => now);
  return { redis, store, advance: (seconds: number) => (now += seconds * 1000) };
}

const flow = { state: 's', nonce: 'n', verifier: 'v', organization: '', next: '/dashboard' };

describe('FlowStore', () => {
  it('generates unguessable ids', () => {
    const { store } = build();
    const a = store.newFlowId();
    const b = store.newFlowId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the record under a hash of the id, for ten minutes, and never the id itself', async () => {
    const { store, redis } = build();
    const id = store.newFlowId();
    await store.save(id, flow);
    const [key, entry] = [...redis.data.entries()][0]!;
    expect(key).toBe(`w360:flow:${createHash('sha256').update(id).digest('hex')}`);
    expect(key).not.toContain(id);
    expect(entry.ttl).toBe(FLOW_TTL_SECONDS);
    expect(FLOW_TTL_SECONDS).toBe(600);
  });

  it('returns the flow once, then never again', async () => {
    const { store } = build();
    const id = store.newFlowId();
    await store.save(id, flow);
    expect(await store.consume(id)).toMatchObject(flow);
    expect(await store.consume(id)).toBeNull();
  });

  it('refuses an unknown or malformed id without touching the store', async () => {
    const { store } = build();
    expect(await store.consume(store.newFlowId())).toBeNull();
    expect(await store.consume('')).toBeNull();
    expect(await store.consume('short')).toBeNull();
    expect(await store.consume('has spaces and is long enough to pass a length check')).toBeNull();
  });

  it('refuses a flow older than ten minutes even if the key survived', async () => {
    const { store, advance } = build();
    const id = store.newFlowId();
    await store.save(id, flow);
    advance(FLOW_TTL_SECONDS + 1);
    expect(await store.consume(id)).toBeNull();
  });

  it('refuses a corrupted record', async () => {
    const { store, redis } = build();
    const id = store.newFlowId();
    await redis.set(`w360:flow:${createHash('sha256').update(id).digest('hex')}`, 'not json', 'EX', 60);
    expect(await store.consume(id)).toBeNull();
  });
});
