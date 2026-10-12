import { PrismaClient } from '@digisoft/db';
import { LinkOrganizationError, linkOrganization } from '../workeasy360/link-organization';

/**
 * Usage: link-workeasy360-organization <helpdeskOrgId> <workeasy360OrgId>
 *
 * Attaches an existing Help Desk organization to its Workeasy360 organization before its
 * first Workeasy360 sign-in. Otherwise that sign-in creates a new, empty organization.
 */
async function main(): Promise<number> {
  const [helpdeskOrganizationId, workeasy360OrganizationId] = process.argv.slice(2);
  if (!helpdeskOrganizationId || !workeasy360OrganizationId) {
    console.error('Usage: link-workeasy360-organization <helpdeskOrgId> <workeasy360OrgId>');
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const result = await linkOrganization(prisma, helpdeskOrganizationId, workeasy360OrganizationId);
    console.log(
      result.changed
        ? `Linked "${result.organizationName}" (${result.organizationId}) to Workeasy360 organization ${result.workeasy360OrganizationId}.`
        : `"${result.organizationName}" was already linked to ${result.workeasy360OrganizationId}; nothing changed.`,
    );
    console.log(
      'Its agents are linked to their Workeasy360 accounts at their first sign-in (by verified email). ' +
        'Sessions already open pick the link up at their next refresh.',
    );
    return 0;
  } catch (error) {
    if (error instanceof LinkOrganizationError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
