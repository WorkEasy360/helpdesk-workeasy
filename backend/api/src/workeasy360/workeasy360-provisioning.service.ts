import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantContext } from '@digisoft/db';
import type { VerifiedIdToken } from '@digisoft/workeasy360';
import { AuditService } from '../audit/audit.service';
import { AccessControlService } from '../auth/access-control.service';
import { provisionOrganization } from '../auth/organization-provisioning';
import { uniqueSlug } from '../common/util/slug';
import { PrismaService } from '../prisma/prisma.service';
import { Workeasy360Settings } from './workeasy360.settings';
import { SsoRefusal } from './sso-errors';

/** Shown until an owner renames it, when the token carries no organization name. */
export const FALLBACK_ORGANIZATION_NAME = 'My organization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvisionedSignIn {
  userId: string;
  organizationId: string;
  /** This sign-in created the organization (and its first person is SUPER_ADMIN). */
  organizationCreated: boolean;
  /** This sign-in linked an existing local account to the Workeasy360 identity. */
  linked: boolean;
  /** This sign-in created the person. */
  userCreated: boolean;
}

/**
 * Turns verified Workeasy360 claims into an organization and a person.
 *
 * Who someone is comes from (issuer, sub) inside the organization bound to the token's
 * `organization_id`; the email is profile data, used to link an existing local account only
 * when Workeasy360 says it verified the address. Both are already verified (the OIDC client),
 * and Workeasy360 has already checked membership, product entitlement and seat before it
 * issued the token, so this decides only how the result maps onto Help Desk's own rows.
 *
 * Platform-level code: it runs before a tenant exists, so it uses the raw client and passes
 * `organizationId` explicitly on every query, like AuthService.
 */
@Injectable()
export class Workeasy360ProvisioningService {
  private readonly logger = new Logger(Workeasy360ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: Workeasy360Settings,
    private readonly accessControl: AccessControlService,
    private readonly audit: AuditService,
  ) {}

  async provision(claims: VerifiedIdToken, issuer: string): Promise<ProvisionedSignIn> {
    const organizationBinding = String(claims.organization_id ?? '').toLowerCase();
    if (!UUID.test(organizationBinding)) {
      throw new SsoRefusal('refused', 'organization_id is not a UUID');
    }

    let result: ProvisionedSignIn;
    try {
      result = await this.provisionOnce(claims, issuer, organizationBinding);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two sign-ins racing (the same person in two tabs, or two people from one new
      // organization): whichever won created the rows. Look again once; a second collision
      // means a concurrent sign-in linked something different.
      try {
        result = await this.provisionOnce(claims, issuer, organizationBinding);
      } catch (again) {
        if (isUniqueViolation(again)) {
          throw new SsoRefusal('account_conflict', 'a concurrent sign-in linked a different account');
        }
        throw again;
      }
    }

    await this.record(result, claims);
    return result;
  }

  private async provisionOnce(
    claims: VerifiedIdToken,
    issuer: string,
    organizationBinding: string,
  ): Promise<ProvisionedSignIn> {
    const organization = await this.prisma.organization.findUnique({
      where: { workeasy360OrganizationId: organizationBinding },
      select: { id: true, deletedAt: true },
    });

    if (!organization) {
      return this.createOrganization(claims, issuer, organizationBinding);
    }
    if (organization.deletedAt) {
      throw new SsoRefusal('organization_inactive', `organization ${organization.id} is deleted`);
    }
    return this.signInToOrganization(organization.id, claims, issuer);
  }

  // --- a new organization -------------------------------------------------

  private async createOrganization(
    claims: VerifiedIdToken,
    issuer: string,
    organizationBinding: string,
  ): Promise<ProvisionedSignIn> {
    const email = this.verifiedEmail(claims);
    const name = (claims.organization_name ?? '').trim().slice(0, 120) || FALLBACK_ORGANIZATION_NAME;
    const slug = await uniqueSlug(
      name,
      async (candidate) =>
        (await this.prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) !== null ||
        (await this.prisma.helpCenter.findUnique({ where: { slug: candidate }, select: { id: true } })) !== null,
      'organization',
    );
    const person = personName(claims, email);

    // No password: the first person can only be reached through Workeasy360.
    const created = await this.prisma.$transaction((tx) =>
      provisionOrganization(
        tx,
        { name, slug, timezone: 'UTC', workeasy360OrganizationId: organizationBinding },
        {
          email,
          passwordHash: null,
          firstName: person.firstName,
          lastName: person.lastName,
          emailVerifiedAt: new Date(),
          externalIdentity: { issuer, subject: claims.sub, email },
        },
      ),
    );
    await this.touchLogin(created.organizationId, created.userId);
    return {
      userId: created.userId,
      organizationId: created.organizationId,
      organizationCreated: true,
      linked: false,
      userCreated: true,
    };
  }

  // --- an organization we already have ------------------------------------

  private async signInToOrganization(
    organizationId: string,
    claims: VerifiedIdToken,
    issuer: string,
  ): Promise<ProvisionedSignIn> {
    const subject = claims.sub;

    // 1. Known Workeasy360 account: the same person, however their address changed since.
    const identity = await this.prisma.externalIdentity.findUnique({
      where: { issuer_subject_organizationId: { issuer, subject, organizationId } },
      select: {
        id: true,
        user: { select: { id: true, type: true, isActive: true, deletedAt: true } },
      },
    });
    if (identity) {
      const { user } = identity;
      if (!user.isActive || user.deletedAt) {
        throw new SsoRefusal('account_disabled', `user ${user.id} is inactive`);
      }
      if (user.type !== 'AGENT') {
        throw new SsoRefusal('account_conflict', `user ${user.id} is not an agent`);
      }
      await this.prisma.externalIdentity.update({
        where: { id: identity.id },
        data: { lastLoginAt: new Date(), ...(claims.email ? { email: claims.email.toLowerCase() } : {}) },
      });
      await this.touchLogin(organizationId, user.id);
      return { userId: user.id, organizationId, organizationCreated: false, linked: false, userCreated: false };
    }

    // 2. Unknown account: it needs a verified address either to link or to create.
    const email = this.verifiedEmail(claims);

    const existing = await this.prisma.user.findUnique({
      where: { organizationId_email: { organizationId, email } },
      select: { id: true, type: true, isActive: true, deletedAt: true, emailVerifiedAt: true },
    });
    if (existing) {
      if (!existing.isActive || existing.deletedAt) {
        throw new SsoRefusal('account_disabled', `user ${existing.id} is inactive`);
      }
      if (existing.type !== 'AGENT') {
        // A customer of this help center is not an agent, and signing in must not turn them into one.
        throw new SsoRefusal('account_conflict', `user ${existing.id} is a customer`);
      }
      const linkedElsewhere = await this.prisma.externalIdentity.findUnique({
        where: { issuer_userId: { issuer, userId: existing.id } },
        select: { id: true },
      });
      if (linkedElsewhere) {
        // Already linked to a different Workeasy360 account.
        throw new SsoRefusal('account_conflict', `user ${existing.id} is linked to another subject`);
      }
      await this.linkExisting(organizationId, existing.id, existing.emailVerifiedAt, { issuer, subject, email });
      return { userId: existing.id, organizationId, organizationCreated: false, linked: true, userCreated: false };
    }

    // 3. Nobody by that address: a new agent with the default role and no password.
    const role = await this.prisma.role.findFirst({
      where: { organizationId, systemKey: this.settings.defaultRole },
      select: { id: true },
    });
    if (!role) {
      throw new SsoRefusal('unavailable', `role ${this.settings.defaultRole} is missing in ${organizationId}`);
    }
    const person = personName(claims, email);
    const user = await this.prisma.user.create({
      data: {
        organizationId,
        email,
        passwordHash: null,
        firstName: person.firstName,
        lastName: person.lastName,
        type: 'AGENT',
        emailVerifiedAt: new Date(),
        lastLoginAt: new Date(),
        roles: { create: { roleId: role.id } },
        externalIdentities: { create: { organizationId, issuer, subject, email } },
      },
      select: { id: true },
    });
    await this.accessControl.invalidateUser(organizationId, user.id);
    return { userId: user.id, organizationId, organizationCreated: false, linked: false, userCreated: true };
  }

  /**
   * Links a local account to a Workeasy360 identity. Help Desk never verified this address
   * itself, so whoever chose the account's password may not be the person Workeasy360 just
   * vouched for (an account pre-registered under someone else's address). From the link on
   * the account is reached through Workeasy360 only: the password goes and every refresh
   * token it issued is revoked.
   */
  private async linkExisting(
    organizationId: string,
    userId: string,
    emailVerifiedAt: Date | null,
    identity: { issuer: string; subject: string; email: string },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.externalIdentity.create({
        data: { organizationId, userId, issuer: identity.issuer, subject: identity.subject, email: identity.email },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: null, emailVerifiedAt: emailVerifiedAt ?? now, lastLoginAt: now },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      // A reset or invitation link mailed before the link would set a password on an account
      // that is now reached through Workeasy360 only: it must not outlive the link.
      this.prisma.verificationToken.updateMany({
        where: { userId, type: { in: ['PASSWORD_RESET', 'INVITE'] }, usedAt: null },
        data: { usedAt: now },
      }),
    ]);
    await this.accessControl.invalidateUser(organizationId, userId);
  }

  private async touchLogin(organizationId: string, userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.accessControl.invalidateUser(organizationId, userId);
  }

  /** The address Workeasy360 vouches for. Anything else neither links nor creates an account. */
  private verifiedEmail(claims: VerifiedIdToken): string {
    const email = (claims.email ?? '').trim().toLowerCase();
    if (!email) {
      throw new SsoRefusal('email_missing', 'the ID token carries no email claim');
    }
    if (claims.email_verified !== true) {
      // Whoever registered an unproven address at Workeasy360 must not take over the
      // account that has it here, nor squat the address its real owner arrives with.
      throw new SsoRefusal('email_unverified', 'the provider has not verified the address');
    }
    return email;
  }

  private async record(result: ProvisionedSignIn, claims: VerifiedIdToken): Promise<void> {
    const base = {
      organizationId: result.organizationId,
      actorId: result.userId,
      entity: 'User',
      entityId: result.userId,
    };
    try {
      await TenantContext.run(result.organizationId, async () => {
        if (result.organizationCreated) {
          await this.audit.record({
            ...base,
            action: 'organization.provisioned_from_workeasy360',
            entity: 'Organization',
            entityId: result.organizationId,
            newValue: { workeasy360OrganizationId: claims.organization_id },
          });
        }
        if (result.linked) {
          await this.audit.record({ ...base, action: 'user.workeasy360_linked', newValue: { subject: claims.sub } });
        }
        await this.audit.record({ ...base, action: 'auth.workeasy360_sign_in', newValue: { aal: claims['aal'] ?? null } });
      });
    } catch (error) {
      this.logger.warn(`Audit entry for a Workeasy360 sign-in failed: ${error instanceof Error ? error.name : 'error'}`);
    }
  }
}

function personName(claims: VerifiedIdToken, email: string): { firstName: string; lastName: string } {
  const given = (claims.given_name ?? '').trim();
  const family = (claims.family_name ?? '').trim();
  if (given || family) {
    return { firstName: (given || family).slice(0, 80), lastName: (given ? family : '').slice(0, 80) };
  }
  const [first = '', ...rest] = (claims.name ?? '').trim().split(/\s+/);
  if (first) return { firstName: first.slice(0, 80), lastName: rest.join(' ').slice(0, 80) };
  return { firstName: (email.split('@')[0] ?? 'Agent').slice(0, 80) || 'Agent', lastName: '' };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
