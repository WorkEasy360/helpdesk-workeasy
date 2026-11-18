import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { AccessTokenPayload } from './token.service';

/** Every API instance listens here and drops the realtime sockets of the sessions named. */
export const SESSION_ENDED_CHANNEL = 'rt:session-ended';
/** The longest a sign-out or a logout token waits for Redis to take the announcement. */
const ANNOUNCE_TIMEOUT_MS = 1000;

export type SessionState = 'live' | 'ended' | 'account_disabled';

export interface SessionEndedMessage {
  /** Refresh-token families (sessions) that ended. */
  families: string[];
}

/**
 * Is the session an access token belongs to still open?
 *
 * A session is a refresh-token family. Every access token names its family (`fam`), and a
 * request is served only while that family is live: it still holds an unrevoked refresh token,
 * and, for a Workeasy360 session, the sign-in that opened it has not been ended by a back-channel
 * logout. So whatever ends a session - a logout token from Workeasy360, Sign out, a password change
 * or reset, a replayed refresh token, an account switch, a deactivated user, binding the
 * organization to Workeasy360 - ends its access tokens with it, on every API instance at once and
 * across restarts, because the answer comes from PostgreSQL and nothing is remembered in a process.
 *
 * The same round trip also says whether the account itself is still active (not deactivated, not
 * deleted): deactivating someone revokes their sessions too, and they are told the more precise
 * reason, ACCOUNT_DISABLED, as before.
 *
 * Cost: one query per authenticated request (and per realtime handshake and re-check), three index
 * probes - `users` by primary key, `refresh_tokens (userId, familyId)` and the unique
 * `workeasy360_sign_ins (familyId)` - on the raw client, inside one round trip. There is no cache:
 * a cached "live" would delay a revocation, and nothing else is worth caching. A token without
 * `fam` (issued before this release) is not live: the browser renews it once, transparently, and
 * gets one that is.
 */
@Injectable()
export class SessionLivenessService {
  private readonly logger = new Logger(SessionLivenessService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * What the session of these (verified) claims is: `live`, `ended` (or never named), or
   * `account_disabled` (the account itself is deactivated or deleted, whatever the session says).
   * Throws when the database cannot say.
   */
  async state(claims: Pick<AccessTokenPayload, 'sub' | 'org' | 'fam'>): Promise<SessionState> {
    const family = claims.fam ?? '';
    const rows = await this.prisma.$queryRaw<{ account: boolean; live: boolean }[]>`
      SELECT EXISTS (
               SELECT 1 FROM "users"
                WHERE "id" = ${claims.sub}
                  AND "organizationId" = ${claims.org}
                  AND "isActive"
                  AND "deletedAt" IS NULL
             ) AS account,
             EXISTS (
               SELECT 1 FROM "refresh_tokens"
                WHERE "userId" = ${claims.sub}
                  AND "familyId" = ${family}
                  AND "organizationId" = ${claims.org}
                  AND "revokedAt" IS NULL
             )
         AND NOT EXISTS (
               SELECT 1 FROM "workeasy360_sign_ins"
                WHERE "familyId" = ${family}
                  AND "endedAt" IS NOT NULL
             ) AS live`;
    const row = rows[0];
    if (!row?.account) return 'account_disabled';
    return claims.fam && row.live ? 'live' : 'ended';
  }

  /** Whether the session of these (verified) claims is open. Throws when the database cannot say. */
  async isLive(claims: Pick<AccessTokenPayload, 'sub' | 'org' | 'fam'>): Promise<boolean> {
    return (await this.state(claims)) === 'live';
  }

  /**
   * Tells every API instance that these sessions ended, so their open realtime sockets are
   * dropped now rather than at the next re-check. Best effort: requests are refused whatever
   * happens here (the database is the authority), and a socket that missed the message is
   * dropped at its next re-check (REALTIME_ACCESS_RECHECK_SECONDS).
   */
  async announceEnded(families: readonly string[]): Promise<void> {
    const unique = [...new Set(families)].filter(Boolean);
    if (unique.length === 0) return;
    const message: SessionEndedMessage = { families: unique };
    let timer: NodeJS.Timeout | undefined;
    try {
      // A Redis that is away must not hold up the sign-out or the logout token's answer: ioredis
      // would queue the command until it reconnects, so the wait is bounded.
      await Promise.race([
        this.redis.publish(SESSION_ENDED_CHANNEL, JSON.stringify(message)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('Redis did not take the announcement'), { name: 'TimeoutError' })),
            ANNOUNCE_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.logger.warn({
        msg: 'session.ended_announcement_failed',
        sessions: unique.length,
        detail: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
