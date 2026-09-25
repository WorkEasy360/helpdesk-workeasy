import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';

/**
 * Metadata key `@Throttle({ auth: … })` writes. @nestjs/throttler does not export its
 * constants; throttler.options.spec.ts fails if the library ever changes this key.
 */
export const AUTH_THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITauth';

export interface ThrottleSettings {
  enabled: boolean;
  ttlSeconds: number;
  limit: number;
  authLimit: number;
}

/**
 * Two named throttlers. `default` applies to every route. `auth` is the tight
 * credential-guessing limit, and in @nestjs/throttler v6 a named throttler also
 * applies to every route unless skipped — which put /health, and everything else, behind
 * AUTH_THROTTLE_LIMIT requests a minute. It is therefore opt-in: it runs only on
 * handlers (or controllers) that set their own `@Throttle({ auth: … })`.
 */
export function buildThrottlerOptions(
  settings: ThrottleSettings,
  storage?: ThrottlerStorage,
): ThrottlerModuleOptions {
  const reflector = new Reflector();
  const optedIntoAuth = (context: ExecutionContext): boolean =>
    reflector.getAllAndOverride<number | undefined>(AUTH_THROTTLE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) !== undefined;

  return {
    skipIf: () => !settings.enabled,
    ...(storage ? { storage } : {}),
    throttlers: [
      {
        name: 'default',
        ttl: settings.ttlSeconds * 1000,
        limit: settings.limit,
      },
      {
        name: 'auth',
        ttl: 60_000,
        limit: settings.authLimit,
        // A per-throttler skipIf replaces the module-level one, so it repeats the switch.
        skipIf: (context) => !settings.enabled || !optedIntoAuth(context),
      },
    ],
  };
}
