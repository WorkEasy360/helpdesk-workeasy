import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@digisoft/db';
import type { VerifiedLogoutToken } from '@digisoft/workeasy360';
import { PrismaService } from '../prisma/prisma.service';

/** One process deletes the remembered `jti`s that can no longer be replayed at most this often. */
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

/** What a Workeasy360 sign-in opened, recorded by the callback before the session is issued. */
export interface SignInRecord {
  organizationId: string;
  userId: string;
  /** The refresh-token family of the new session. */
  familyId: string;
  issuer: string;
  subject: string;
  /** The ID token's `sid`, when Workeasy360 issued one (only once a back-channel URI is registered). */
  providerSid: string | null;
}

export type LogoutOutcome =
  /** The token was accepted; `sessions` is how many live sessions (refresh-token families) it ended, possibly none. */
  | { status: 'ended'; by: 'sid' | 'sub'; sessions: number }
  /** This `jti` was accepted before: nothing was done. */
  | { status: 'replayed' };

type Tx = Prisma.TransactionClient;

/**
 * The storage half of OpenID Connect Back-Channel Logout 1.0 (section 2.7).
 *
 * A Help Desk session is a refresh-token family: signing out revokes the family, and the access
 * token it last issued lapses on its own (JWT_EXPIRES_IN). The Workeasy360 callback records, per
 * sign-in, which family it opened, for whom (issuer, sub) and under which Workeasy360 sign-in
 * (`sid`). A verified logout token then ends:
 *
 * - with `sid`: the families that sign-in opened (narrowed to `sub` when the token names both);
 * - with `sub` only: every session of that person, that is every unrevoked refresh token of each
 *   Help Desk user linked to (issuer, sub) - one per organization the person works in - whatever
 *   way it was started.
 *
 * Recording the `jti` and ending the sessions are one transaction: if anything fails, nothing
 * happened (the `jti` included), so Workeasy360's retry is not refused as a replay. Ending a
 * session that has already ended changes nothing, which is what at-least-once delivery needs.
 *
 * Platform-level code: the request carries no tenant, so it uses the raw client.
 */
@Injectable()
export class BackchannelLogoutService {
  private readonly logger = new Logger(BackchannelLogoutService.name);
  private lastPurge = 0;

  constructor(private readonly prisma: PrismaService) {}

  async recordSignIn(record: SignInRecord): Promise<void> {
    await this.prisma.workeasy360SignIn.create({ data: record });
  }

  /** Ends what a verified logout token names. Throws when the store fails (the caller answers 503). */
  async end(issuer: string, token: VerifiedLogoutToken): Promise<LogoutOutcome> {
    const now = new Date();
    let outcome: LogoutOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // First, so a concurrent delivery of the same token waits on the key and then fails.
        await tx.workeasy360LogoutToken.create({
          data: { issuer, jti: token.jti, expiresAt: new Date(token.acceptableUntil * 1000) },
        });
        if (token.sid) return this.endSignIn(tx, issuer, token.sid, token.sub, now);
        // The verifier guarantees a sub when there is no sid.
        return this.endPerson(tx, issuer, token.sub!, now);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'replayed' };
      throw error;
    }
    await this.purgeExpired(now);
    return outcome;
  }

  private async endSignIn(
    tx: Tx,
    issuer: string,
    sid: string,
    subject: string | undefined,
    now: Date,
  ): Promise<LogoutOutcome> {
    const signIns = await tx.workeasy360SignIn.findMany({
      where: { issuer, providerSid: sid, ...(subject ? { subject } : {}) },
      select: { id: true, userId: true, familyId: true },
    });
    if (signIns.length === 0) return { status: 'ended', by: 'sid', sessions: 0 };
    const sessions = await this.revoke(
      tx,
      {
        userId: { in: unique(signIns.map((s) => s.userId)) },
        familyId: { in: signIns.map((s) => s.familyId) },
      },
      now,
    );
    await tx.workeasy360SignIn.updateMany({
      where: { id: { in: signIns.map((s) => s.id) }, endedAt: null },
      data: { endedAt: now },
    });
    return { status: 'ended', by: 'sid', sessions };
  }

  private async endPerson(
    tx: Tx,
    issuer: string,
    subject: string,
    now: Date,
  ): Promise<LogoutOutcome> {
    const identities = await tx.externalIdentity.findMany({
      where: { issuer, subject },
      select: { userId: true },
    });
    const signIns = await tx.workeasy360SignIn.findMany({
      where: { issuer, subject },
      select: { userId: true },
    });
    const userIds = unique([...identities, ...signIns].map((row) => row.userId));
    if (userIds.length === 0) return { status: 'ended', by: 'sub', sessions: 0 };
    const sessions = await this.revoke(tx, { userId: { in: userIds } }, now);
    await tx.workeasy360SignIn.updateMany({
      where: { userId: { in: userIds }, endedAt: null },
      data: { endedAt: now },
    });
    return { status: 'ended', by: 'sub', sessions };
  }

  /** Revokes every unrevoked refresh token matching `where`; returns how many families were live. */
  private async revoke(tx: Tx, where: Prisma.RefreshTokenWhereInput, now: Date): Promise<number> {
    const live = await tx.refreshToken.findMany({
      where: { ...where, revokedAt: null, expiresAt: { gt: now } },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await tx.refreshToken.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: now },
    });
    return live.length;
  }

  /** Best effort: a `jti` past its token's acceptance window can never be replayed, so its row can go. */
  private async purgeExpired(now: Date): Promise<void> {
    if (now.getTime() - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now.getTime();
    try {
      await this.prisma.workeasy360LogoutToken.deleteMany({ where: { expiresAt: { lt: now } } });
    } catch (error) {
      this.logger.warn({
        msg: 'workeasy360.logout_token_purge_failed',
        detail: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
