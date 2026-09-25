/**
 * Development seed: provisions a demo organization with the five system roles, an
 * admin user, departments, accounts and contacts. Safe to re-run — it is a no-op if
 * the demo organization already exists.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { SYSTEM_ROLES } from '@digisoft/shared';
import { provisionSystemRoles, syncPermissionCatalogue } from '../src/role-provisioning';
import { provisionSlaDefaults, provisionTicketDefaults } from '../src/ticket-provisioning';
import { provisionHelpCenter } from '../src/portal-provisioning';

const prisma = new PrismaClient();

const DEFAULT_ADMIN_PASSWORD = 'ChangeMe123!';

const DEMO = {
  organizationName: 'Digisoft360 Demo',
  organizationSlug: 'demo',
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@digisoft360.local',
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD,
};

async function main(): Promise<void> {
  // The demo admin is a Super Admin with a published password; a production database
  // must never get one by accident.
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD)
  ) {
    throw new Error(
      'Refusing to seed in production without SEED_ADMIN_PASSWORD set to something other than the default',
    );
  }

  await syncPermissionCatalogue(prisma);

  // Organizations created before a phase added new configuration need it backfilled.
  await backfillTicketDefaults();

  const existing = await prisma.organization.findUnique({
    where: { slug: DEMO.organizationSlug },
    select: { id: true },
  });
  if (existing) {
    console.log(`Organization "${DEMO.organizationSlug}" already seeded — nothing else to do.`);
    return;
  }

  const passwordHash = await argon2.hash(DEMO.adminPassword, { type: argon2.argon2id });

  await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: DEMO.organizationName,
        slug: DEMO.organizationSlug,
        timezone: 'Asia/Kolkata',
      },
      select: { id: true },
    });

    const roleIds = await provisionSystemRoles(tx, organization.id);
    const superAdminRoleId = roleIds[SYSTEM_ROLES.SUPER_ADMIN];
    const agentRoleId = roleIds[SYSTEM_ROLES.AGENT];
    if (!superAdminRoleId || !agentRoleId) {
      throw new Error('System roles were not provisioned');
    }

    await tx.businessHours.create({
      data: {
        organizationId: organization.id,
        name: 'Default business hours',
        timezone: 'Asia/Kolkata',
        isDefault: true,
        weeklySchedule: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '18:00' })),
      },
    });

    const support = await tx.department.create({
      data: {
        organizationId: organization.id,
        name: 'Customer Support',
        description: 'First line support.',
        isDefault: true,
      },
      select: { id: true },
    });

    await tx.department.create({
      data: {
        organizationId: organization.id,
        name: 'Technical Support',
        description: 'Escalated technical issues.',
      },
    });

    const admin = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: DEMO.adminEmail,
        passwordHash,
        firstName: 'Demo',
        lastName: 'Admin',
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: superAdminRoleId } },
        departments: { create: { departmentId: support.id } },
      },
      select: { id: true },
    });

    const agent = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: 'agent@digisoft360.local',
        passwordHash,
        firstName: 'Demo',
        lastName: 'Agent',
        emailVerifiedAt: new Date(),
        roles: { create: { roleId: agentRoleId } },
        departments: { create: { departmentId: support.id } },
      },
      select: { id: true },
    });

    const account = await tx.account.create({
      data: {
        organizationId: organization.id,
        name: 'Northwind Traders',
        website: 'https://example.com',
        industry: 'Retail',
        city: 'Pune',
        country: 'India',
      },
      select: { id: true },
    });

    await provisionTicketDefaults(tx, organization.id);
    await provisionSlaDefaults(tx, organization.id);
    await provisionHelpCenter(tx, organization.id, {
      name: DEMO.organizationName,
      slug: DEMO.organizationSlug,
    });

    await tx.contact.createMany({
      data: [
        {
          organizationId: organization.id,
          accountId: account.id,
          firstName: 'Asha',
          lastName: 'Menon',
          email: 'asha.menon@example.com',
          jobTitle: 'Operations Lead',
          isVip: true,
        },
        {
          organizationId: organization.id,
          accountId: account.id,
          firstName: 'Rahul',
          lastName: 'Verma',
          email: 'rahul.verma@example.com',
          jobTitle: 'IT Administrator',
        },
      ],
    });
    const [status, priority, category] = await Promise.all([
      tx.ticketStatus.findFirstOrThrow({
        where: { organizationId: organization.id, isDefault: true },
        select: { id: true },
      }),
      tx.ticketPriority.findFirstOrThrow({
        where: { organizationId: organization.id, isDefault: true },
        select: { id: true },
      }),
      tx.ticketCategory.findFirstOrThrow({
        where: { organizationId: organization.id, name: 'Technical' },
        select: { id: true },
      }),
    ]);

    const asha = await tx.contact.findFirstOrThrow({
      where: { organizationId: organization.id, firstName: 'Asha' },
      select: { id: true, accountId: true },
    });

    const organizationAfter = await tx.organization.update({
      where: { id: organization.id },
      data: { ticketSequence: { increment: 1 } },
      select: { ticketSequence: true },
    });

    const ticket = await tx.ticket.create({
      data: {
        organizationId: organization.id,
        ticketNumber: organizationAfter.ticketSequence,
        subject: 'Cannot sign in to the customer portal',
        description:
          'Our operations team is seeing "invalid credentials" when signing in, even after a password reset.',
        source: 'EMAIL',
        contactId: asha.id,
        accountId: asha.accountId,
        departmentId: support.id,
        categoryId: category.id,
        statusId: status.id,
        priorityId: priority.id,
        createdById: admin.id,
        assignedAgentId: agent.id,
        followers: { create: [{ userId: admin.id }, { userId: agent.id }] },
      },
      select: { id: true },
    });

    await tx.ticketMessage.createMany({
      data: [
        {
          organizationId: organization.id,
          ticketId: ticket.id,
          type: 'PUBLIC_REPLY',
          direction: 'INBOUND',
          authorContactId: asha.id,
          channel: 'EMAIL',
          bodyText: 'This started this morning and affects three of our users.',
        },
        {
          organizationId: organization.id,
          ticketId: ticket.id,
          type: 'INTERNAL_COMMENT',
          authorUserId: agent.id,
          bodyText: 'Auth logs show repeated failures from one IP range. Checking the rate limiter.',
        },
      ],
    });
  });

  console.log(`Seeded organization "${DEMO.organizationSlug}".`);
  console.log(`  Admin: ${DEMO.adminEmail} / ${DEMO.adminPassword}`);
}

/** Gives every organization the ticket statuses, priorities and categories it needs. */
async function backfillTicketDefaults(): Promise<void> {
  const organizations = await prisma.organization.findMany({
    where: { ticketStatuses: { none: {} } },
    select: { id: true, slug: true },
  });

  for (const organization of organizations) {
    await prisma.$transaction((tx) => provisionTicketDefaults(tx, organization.id));
    console.log(`Provisioned ticket defaults for "${organization.slug}".`);
  }

  // Statuses created before the flag existed default to not pausing; the two system
  // statuses that mean "waiting on someone else" should.
  const pausing = await prisma.ticketStatus.updateMany({
    where: { isSystem: true, systemKey: { in: ['ON_HOLD', 'PENDING'] }, pausesSla: false },
    data: { pausesSla: true },
  });
  if (pausing.count > 0) console.log(`Marked ${pausing.count} system status(es) as pausing the SLA clock.`);

  const withoutSla = await prisma.organization.findMany({
    where: { slaPolicies: { none: {} } },
    select: { id: true, slug: true },
  });
  for (const organization of withoutSla) {
    await prisma.$transaction((tx) => provisionSlaDefaults(tx, organization.id));
    console.log(`Provisioned the default SLA policy for "${organization.slug}".`);
  }

  const withoutHelpCenter = await prisma.organization.findMany({
    where: { helpCenter: { is: null } },
    select: { id: true, name: true, slug: true },
  });
  for (const organization of withoutHelpCenter) {
    await prisma.$transaction((tx) =>
      provisionHelpCenter(tx, organization.id, { name: organization.name, slug: organization.slug }),
    );
    console.log(`Provisioned the help center for "${organization.slug}".`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
