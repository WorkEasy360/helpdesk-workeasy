import { SYSTEM_ROLES } from '@digisoft/shared';
import {
  DEFAULT_BUSINESS_HOURS,
  provisionHelpCenter,
  provisionSlaDefaults,
  provisionSystemRoles,
  provisionTicketDefaults,
  type Prisma,
} from '@digisoft/db';

export interface NewOrganization {
  name: string;
  slug: string;
  timezone: string;
  /** Binds the organization to a Workeasy360 organization (the ID token's `organization_id`). */
  workeasy360OrganizationId?: string | null;
}

export interface FirstUser {
  email: string;
  firstName: string;
  lastName: string;
  /** Null: the account can only be reached through Workeasy360. */
  passwordHash: string | null;
  emailVerifiedAt?: Date | null;
  /** The federated identity to link in the same transaction. */
  externalIdentity?: { issuer: string; subject: string; email?: string | null };
}

/**
 * Creates an organization with everything it needs to work on day one - system roles,
 * business hours, a default department, ticket and SLA defaults, a help center - and its
 * first person as SUPER_ADMIN. The one place this happens: self-service registration and
 * the first Workeasy360 sign-in of a new organization both call it, inside their own
 * transaction, so the two can never produce differently shaped organizations.
 */
export async function provisionOrganization(
  tx: Prisma.TransactionClient,
  organization: NewOrganization,
  owner: FirstUser,
): Promise<{ organizationId: string; userId: string }> {
  const created = await tx.organization.create({
    data: {
      name: organization.name,
      slug: organization.slug,
      timezone: organization.timezone,
      ...(organization.workeasy360OrganizationId
        ? { workeasy360OrganizationId: organization.workeasy360OrganizationId }
        : {}),
    },
    select: { id: true },
  });

  const roleIds = await provisionSystemRoles(tx, created.id);
  const superAdminRoleId = roleIds[SYSTEM_ROLES.SUPER_ADMIN];
  if (!superAdminRoleId) {
    throw new Error('System roles were not provisioned');
  }

  await tx.businessHours.create({
    data: {
      organizationId: created.id,
      name: DEFAULT_BUSINESS_HOURS.name,
      timezone: organization.timezone,
      isDefault: true,
      weeklySchedule: DEFAULT_BUSINESS_HOURS.weeklySchedule,
    },
  });

  await tx.department.create({
    data: {
      organizationId: created.id,
      name: 'General',
      description: 'Default department for incoming requests.',
      isDefault: true,
    },
  });

  // Statuses, priorities and categories, so the organization can raise a ticket the
  // moment it exists.
  await provisionTicketDefaults(tx, created.id);
  await provisionSlaDefaults(tx, created.id);
  await provisionHelpCenter(tx, created.id, { name: organization.name, slug: organization.slug });

  const user = await tx.user.create({
    data: {
      organizationId: created.id,
      email: owner.email,
      passwordHash: owner.passwordHash,
      firstName: owner.firstName,
      lastName: owner.lastName,
      type: 'AGENT',
      ...(owner.emailVerifiedAt ? { emailVerifiedAt: owner.emailVerifiedAt } : {}),
      roles: { create: { roleId: superAdminRoleId } },
      ...(owner.externalIdentity
        ? {
            externalIdentities: {
              create: {
                organizationId: created.id,
                issuer: owner.externalIdentity.issuer,
                subject: owner.externalIdentity.subject,
                email: owner.externalIdentity.email ?? null,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });

  return { organizationId: created.id, userId: user.id };
}
