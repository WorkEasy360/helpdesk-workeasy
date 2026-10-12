import type { Redis } from 'ioredis';

/** The default: sign-in attempts per address per minute on each of the two browser routes (WORKEASY360_SIGN_IN_RATE_LIMIT). */
export const SSO_RATE_LIMIT_PER_MINUTE = 30;
const WINDOW_SECONDS = 60;

/**
 * A fixed-window counter. The key is created with its expiry in one command (SET NX EX) and
 * only then incremented, so a crash or a lost connection between the two can never leave a
 * counter without an expiry, which would lock an address out for good. Returns true when this
 * call is over the limit.
 */
export async function overLimit(
  redis: Pick<Redis, 'set' | 'incr'>,
  key: string,
  limit = SSO_RATE_LIMIT_PER_MINUTE,
): Promise<boolean> {
  await redis.set(key, 0, 'EX', WINDOW_SECONDS, 'NX');
  return (await redis.incr(key)) > limit;
}
