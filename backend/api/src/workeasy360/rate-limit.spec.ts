import { overLimit } from './rate-limit';

function fakeRedis() {
  const data = new Map<string, { value: number; ttl: number | null }>();
  const commands: string[] = [];
  return {
    data,
    commands,
    async set(key: string, value: number, _ex: 'EX', ttl: number, _nx: 'NX') {
      commands.push('set');
      if (!data.has(key)) data.set(key, { value, ttl });
      return data.has(key) ? 'OK' : null;
    },
    async incr(key: string) {
      commands.push('incr');
      const entry = data.get(key) ?? { value: 0, ttl: null };
      entry.value += 1;
      data.set(key, entry);
      return entry.value;
    },
  };
}

describe('the sign-in limiter', () => {
  it('counts to the limit and then refuses', async () => {
    const redis = fakeRedis();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await overLimit(redis as never, 'k', 3));
    expect(results).toEqual([false, false, false, true, true]);
  });

  it('never leaves a counter without an expiry: the key is created with its TTL before it is incremented', async () => {
    const redis = fakeRedis();
    await overLimit(redis as never, 'k');
    expect(redis.commands.slice(0, 2)).toEqual(['set', 'incr']);
    expect(redis.data.get('k')?.ttl).toBe(60);
  });

  it('does not reset an existing window', async () => {
    const redis = fakeRedis();
    redis.data.set('k', { value: 29, ttl: 12 });
    expect(await overLimit(redis as never, 'k')).toBe(false);
    expect(await overLimit(redis as never, 'k')).toBe(true);
    expect(redis.data.get('k')?.ttl).toBe(12);
  });
});
