import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * One round trip, atomic: count the hit in a window that starts with the first hit,
 * and once the count passes the limit set a block key that refuses further hits until
 * it expires. Returns [hits, windowMsLeft, blocked, blockMsLeft].
 */
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockLeft = redis.call('PTTL', blockKey)
if blockLeft > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or '0')
  return { hits, math.max(redis.call('PTTL', hitsKey), 0), 1, blockLeft }
end

local hits = redis.call('INCR', hitsKey)
local windowLeft = redis.call('PTTL', hitsKey)
if windowLeft < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  windowLeft = ttl
end

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  return { hits, windowLeft, 1, blockDuration }
end
return { hits, windowLeft, 0, 0 }
`;

/**
 * Rate-limit counters in Redis, so every API instance behind the load balancer shares
 * one budget per client instead of each granting the full limit.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'throttle',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}:${throttlerName}:${key}`;
    const [hits, windowLeft, blocked, blockLeft] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      Math.max(1, Math.ceil(ttl)),
      limit,
      Math.max(1, Math.ceil(blockDuration)),
    )) as [number, number, number, number];

    // The guard reports these in seconds (Retry-After, X-RateLimit-Reset).
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(windowLeft / 1000),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockLeft / 1000),
    };
  }
}
