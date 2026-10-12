import type { PrismaClient } from '@digisoft/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why an organization could not be linked. The message is for the operator running the script. */
export class LinkOrganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkOrganizationError';
  }
}

export interface LinkResult {
  organizationId: string;
  organizationName: string;
  workeasy360OrganizationId: string;
  /** False: it was already linked to exactly this Workeasy360 organization. */
  changed: boolean;
}

/**
 * Binds an existing Help Desk organization to a Workeasy360 organization, so the first
 * Workeasy360 sign-in from that organization lands in it instead of creating a new, empty
 * one. Existing agents are linked to their Workeasy360 accounts at their own first sign-in
 * (by verified email); nothing else changes.
 */
export async function linkOrganization(
  prisma: Pick<PrismaClient, 'organization' | 'refreshToken'>,
  helpdeskOrganizationId: string,
  workeasy360OrganizationId: string,
): Promise<LinkResult> {
  if (!helpdeskOrganizationId.trim()) {
    throw new LinkOrganizationError('The Help Desk organization id is required.');
  }
  if (!UUID.test(workeasy360OrganizationId)) {
    throw new LinkOrganizationError('The Workeasy360 organization id must be a UUID.');
  }
  const target = workeasy360OrganizationId.toLowerCase();

  const organization = await prisma.organization.findUnique({
    where: { id: helpdeskOrganizationId },
    select: { id: true, name: true, deletedAt: true, workeasy360OrganizationId: true },
  });
  if (!organization || organization.deletedAt) {
    throw new LinkOrganizationError(`No Help Desk organization ${helpdeskOrganizationId}.`);
  }
  if (organization.workeasy360OrganizationId === target) {
    return {
      organizationId: organization.id,
      organizationName: organization.name,
      workeasy360OrganizationId: target,
      changed: false,
    };
  }
  if (organization.workeasy360OrganizationId) {
    throw new LinkOrganizationError(
      `${organization.name} is already linked to Workeasy360 organization ${organization.workeasy360OrganizationId}. ` +
        'Unlink it deliberately (a database change) before linking it to another one.',
    );
  }
  const holder = await prisma.organization.findUnique({
    where: { workeasy360OrganizationId: target },
    select: { id: true, name: true },
  });
  if (holder) {
    throw new LinkOrganizationError(
      `Workeasy360 organization ${target} is already linked to ${holder.name} (${holder.id}). ` +
        'If that one was created by a first sign-in, it is empty and can be deleted first.',
    );
  }

  await prisma.organization.update({
    where: { id: organization.id },
    data: { workeasy360OrganizationId: target },
  });
  // Agents signed in before the binding hold sessions that know nothing of Workeasy360. They
  // end here; each agent signs in again through Workeasy360, which links their account.
  // Customers (help center sessions) are not touched.
  await prisma.refreshToken.updateMany({
    where: { organizationId: organization.id, revokedAt: null, user: { type: 'AGENT' } },
    data: { revokedAt: new Date() },
  });
  return {
    organizationId: organization.id,
    organizationName: organization.name,
    workeasy360OrganizationId: target,
    changed: true,
  };
}
