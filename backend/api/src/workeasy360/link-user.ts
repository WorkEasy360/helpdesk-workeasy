import { Prisma, type PrismaClient } from '@digisoft/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The audit action of every link, by an operator or (never in Help Desk today) automatically. */
export const LINKED_ACTION = 'user.workeasy360_linked';

/** Why an account could not be linked. The message is for the operator running the script. */
export class LinkUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkUserError';
  }
}

export interface LinkUserRequest {
  /** The Help Desk account's address, inside the organization bound to `workeasy360OrganizationId`. */
  email: string;
  /** The person's Workeasy360 `sub`: stable and opaque, never their email. */
  subject: string;
  /** The Workeasy360 organization the person signs in through. */
  workeasy360OrganizationId: string;
  /** Exactly `WORKEASY360_ISSUER`. */
  issuer: string;
  /** Who vouches for the link (the operator's name or address). */
  actor: string;
  /** Why: the ticket, the request, how the person was confirmed. */
  reason: string;
}

export interface LinkUserResult {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  issuer: string;
  subject: string;
  /** False: the account was already linked to exactly this Workeasy360 account. Nothing was written. */
  changed: boolean;
  /** The account's refresh tokens revoked by the link (the sessions its password opened). */
  sessionsEnded: number;
}

type Db = Pick<PrismaClient, 'organization' | 'user' | 'externalIdentity' | 'refreshToken' | 'auditLog' | '$transaction'>;

/**
 * Binds one existing Help Desk account to a Workeasy360 account (issuer, sub), because an
 * operator vouches that they are the same person. This is the only way an existing account is
 * linked: a Workeasy360 sign-in that finds an account with the same address is refused
 * (`account_conflict`) and merges nothing, whatever the address and whoever verified it.
 *
 * It refuses when either side is already taken: the account is linked to a Workeasy360 account
 * (this issuer, or another subject under an earlier issuer), or the Workeasy360 account is linked
 * to someone else in that organization. Staff and administrators are allowed: vouching for them
 * is what the command is for.
 *
 * The link is recorded in the organization's audit log (`user.workeasy360_linked`, method
 * `operator`) with who vouched, when, which accounts and why. The account's password is left
 * as it is (it stops opening anything in SSO-only mode); the sessions the password opened end,
 * so the person's next session is the one Workeasy360 opens.
 */
export async function linkUser(prisma: Db, request: LinkUserRequest): Promise<LinkUserResult> {
  const email = request.email.trim().toLowerCase();
  const subject = request.subject.trim();
  const issuer = request.issuer.trim();
  const actor = request.actor.trim();
  const reason = request.reason.trim();
  if (!email) throw new LinkUserError('The account email is required.');
  if (!subject) throw new LinkUserError('The Workeasy360 subject (sub) is required.');
  if (subject.length > 255) throw new LinkUserError('The Workeasy360 subject is longer than 255 characters.');
  if (!issuer) throw new LinkUserError('The issuer is required (WORKEASY360_ISSUER, or --issuer).');
  if (!UUID.test(request.workeasy360OrganizationId.trim())) {
    throw new LinkUserError('The Workeasy360 organization id must be a UUID.');
  }
  if (!actor) throw new LinkUserError('Say who vouches for this link (--actor).');
  if (!reason) throw new LinkUserError('Say why the accounts are the same person (--reason).');
  const workeasy360OrganizationId = request.workeasy360OrganizationId.trim().toLowerCase();

  const organization = await prisma.organization.findUnique({
    where: { workeasy360OrganizationId },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!organization || organization.deletedAt) {
    throw new LinkUserError(
      `No Help Desk organization is linked to Workeasy360 organization ${workeasy360OrganizationId}. ` +
        'Link the organization first (link-workeasy360-organization).',
    );
  }

  const user = await prisma.user.findUnique({
    where: { organizationId_email: { organizationId: organization.id, email } },
    select: {
      id: true,
      email: true,
      type: true,
      isActive: true,
      deletedAt: true,
      externalIdentities: { select: { issuer: true, subject: true } },
    },
  });
  if (!user) {
    throw new LinkUserError(
      `${organization.name} (${organization.id}) has no account ${email}. ` +
        'The account must belong to the organization bound to that Workeasy360 organization.',
    );
  }
  if (!user.isActive || user.deletedAt) {
    throw new LinkUserError(`${email} is deactivated or deleted in ${organization.name}; reactivate it first.`);
  }
  if (user.type !== 'AGENT') {
    throw new LinkUserError(`${email} is a help center customer; Workeasy360 sign-in is for agents only.`);
  }

  const base = {
    userId: user.id,
    email: user.email,
    organizationId: organization.id,
    organizationName: organization.name,
    issuer,
    subject,
  };
  const same = user.externalIdentities.find((identity) => identity.issuer === issuer);
  if (same && same.subject === subject) {
    return { ...base, changed: false, sessionsEnded: 0 };
  }
  if (same) {
    throw new LinkUserError(`${email} is already linked to another Workeasy360 account (${same.subject}).`);
  }
  // A link under an earlier issuer is the same person only with the same subject (an issuer move
  // keeps subjects): relinking under the new issuer is then allowed; another subject is not.
  const other = user.externalIdentities.find((identity) => identity.subject !== subject);
  if (other) {
    throw new LinkUserError(
      `${email} is already linked to another Workeasy360 account (${other.subject} at ${other.issuer}).`,
    );
  }

  const holder = await prisma.externalIdentity.findUnique({
    where: { issuer_subject_organizationId: { issuer, subject, organizationId: organization.id } },
    select: { user: { select: { id: true, email: true } } },
  });
  if (holder) {
    throw new LinkUserError(
      `Workeasy360 account ${subject} is already linked to ${holder.user.email} (${holder.user.id}) in ${organization.name}.`,
    );
  }

  const now = new Date();
  try {
    const [, revoked] = await prisma.$transaction([
      prisma.externalIdentity.create({
        data: { organizationId: organization.id, userId: user.id, issuer, subject, email: user.email },
      }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
      prisma.auditLog.create({
        data: {
          organizationId: organization.id,
          actorId: null,
          actorType: 'SYSTEM',
          action: LINKED_ACTION,
          entity: 'User',
          entityId: user.id,
          newValue: {
            method: 'operator',
            operator: actor,
            reason,
            issuer,
            subject,
            workeasy360OrganizationId,
            email: user.email,
            linkedAt: now.toISOString(),
          },
        },
      }),
    ]);
    return { ...base, changed: true, sessionsEnded: revoked.count };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new LinkUserError('A concurrent sign-in or link took one of these accounts; nothing changed. Check and retry.');
    }
    throw error;
  }
}
