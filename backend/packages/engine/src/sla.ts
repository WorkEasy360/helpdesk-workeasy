import type { Prisma, PrismaClient } from '@digisoft/db';
import type { ConditionTree } from '@digisoft/shared';
import {
  ALWAYS_OPEN,
  addBusinessMinutes,
  businessMinutesBetween,
  type BusinessCalendar,
} from './business-hours';
import { evaluateConditions, type TicketFacts } from './conditions';

export interface SlaComputation {
  slaPolicyId: string;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
}

async function loadCalendar(
  prisma: PrismaClient,
  organizationId: string,
  businessHoursId: string | null,
): Promise<BusinessCalendar> {
  const hours = businessHoursId
    ? await prisma.businessHours.findFirst({
        where: { id: businessHoursId, organizationId },
        include: { holidays: true },
      })
    : await prisma.businessHours.findFirst({
        where: { organizationId, isDefault: true },
        include: { holidays: true },
      });
  if (!hours) return ALWAYS_OPEN;

  return {
    timezone: hours.timezone,
    weeklySchedule: (hours.weeklySchedule as unknown as BusinessCalendar['weeklySchedule']) ?? [],
    holidays: hours.holidays.map((holiday) => holiday.date.toISOString().slice(0, 10)),
  };
}

export type SlaPolicyWithTargets = Prisma.SlaPolicyGetPayload<{ include: { targets: true } }>;

/** The first active policy whose conditions match, else the default policy. */
export async function selectSlaPolicy(
  prisma: PrismaClient,
  organizationId: string,
  facts: TicketFacts,
): Promise<SlaPolicyWithTargets | null> {
  const policies = await prisma.slaPolicy.findMany({
    where: { organizationId, isActive: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: { targets: true },
  });

  const matched = policies.find(
    (policy) => !policy.isDefault && evaluateConditions(facts, policy.conditions as ConditionTree),
  );
  return matched ?? policies.find((policy) => policy.isDefault) ?? null;
}

/**
 * Due dates for a ticket under a policy: the target for its priority, or the policy's
 * fallback target, measured in business or wall-clock time as the target says.
 */
export async function computeSlaDueDates(
  prisma: PrismaClient,
  organizationId: string,
  policy: SlaPolicyWithTargets,
  facts: TicketFacts,
  from: Date,
): Promise<SlaComputation | null> {
  const target =
    policy.targets.find((candidate) => candidate.priorityId === facts.priorityId) ??
    policy.targets.find((candidate) => candidate.priorityId === null);
  if (!target) return null;

  const calendar = target.useBusinessHours
    ? await loadCalendar(prisma, organizationId, policy.businessHoursId)
    : ALWAYS_OPEN;

  return {
    slaPolicyId: policy.id,
    firstResponseDueAt: addBusinessMinutes(from, target.firstResponseMinutes, calendar),
    resolutionDueAt: addBusinessMinutes(from, target.resolutionMinutes, calendar),
  };
}

/** Applies (or re-applies) the matching policy to a ticket and returns what was set. */
export async function applySla(
  prisma: PrismaClient,
  organizationId: string,
  ticketId: string,
  facts: TicketFacts,
  createdAt: Date,
  forcedPolicyId?: string,
): Promise<SlaComputation | null> {
  const policy = forcedPolicyId
    ? await prisma.slaPolicy.findFirst({
        where: { id: forcedPolicyId, organizationId, isActive: true },
        include: { targets: true },
      })
    : await selectSlaPolicy(prisma, organizationId, facts);
  if (!policy) return null;

  const computed = await computeSlaDueDates(prisma, organizationId, policy, facts, createdAt);
  if (!computed) return null;

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      slaPolicyId: computed.slaPolicyId,
      firstResponseDueAt: computed.firstResponseDueAt,
      resolutionDueAt: computed.resolutionDueAt,
      dueAt: computed.resolutionDueAt,
      firstResponseWarnedAt: null,
      resolutionWarnedAt: null,
      firstResponseBreachedAt: null,
      resolutionBreachedAt: null,
    },
  });
  return computed;
}

/**
 * Pause: remember how much working time is left on each target. Resume: rebuild the
 * due dates from now with that remainder. Measured on the policy's calendar, so a
 * pause over a weekend does not hand the customer the weekend back as extra time.
 */
export async function pauseSla(prisma: PrismaClient, organizationId: string, ticketId: string, now = new Date()) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, organizationId },
    select: {
      slaPausedAt: true,
      slaPolicyId: true,
      priorityId: true,
      firstResponseAt: true,
      firstResponseDueAt: true,
      resolutionDueAt: true,
      slaPolicy: { select: { businessHoursId: true, targets: true } },
    },
  });
  if (!ticket?.slaPolicyId || ticket.slaPausedAt) return;

  const calendar = await calendarForTicket(prisma, organizationId, ticket);

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      slaPausedAt: now,
      firstResponseRemainingMin:
        ticket.firstResponseAt || !ticket.firstResponseDueAt
          ? null
          : businessMinutesBetween(now, ticket.firstResponseDueAt, calendar),
      resolutionRemainingMin: ticket.resolutionDueAt
        ? businessMinutesBetween(now, ticket.resolutionDueAt, calendar)
        : null,
    },
  });
}

export async function resumeSla(prisma: PrismaClient, organizationId: string, ticketId: string, now = new Date()) {
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, organizationId },
    select: {
      slaPausedAt: true,
      slaPolicyId: true,
      priorityId: true,
      firstResponseRemainingMin: true,
      resolutionRemainingMin: true,
      firstResponseDueAt: true,
      resolutionDueAt: true,
      slaPolicy: { select: { businessHoursId: true, targets: true } },
    },
  });
  if (!ticket?.slaPausedAt) return;

  const calendar = await calendarForTicket(prisma, organizationId, ticket);
  const firstResponseDueAt =
    ticket.firstResponseRemainingMin !== null
      ? addBusinessMinutes(now, ticket.firstResponseRemainingMin, calendar)
      : ticket.firstResponseDueAt;
  const resolutionDueAt =
    ticket.resolutionRemainingMin !== null
      ? addBusinessMinutes(now, ticket.resolutionRemainingMin, calendar)
      : ticket.resolutionDueAt;

  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      slaPausedAt: null,
      firstResponseRemainingMin: null,
      resolutionRemainingMin: null,
      firstResponseDueAt,
      resolutionDueAt,
      dueAt: resolutionDueAt,
    },
  });
}

async function calendarForTicket(
  prisma: PrismaClient,
  organizationId: string,
  ticket: {
    priorityId: string;
    slaPolicy: { businessHoursId: string | null; targets: { priorityId: string | null; useBusinessHours: boolean }[] } | null;
  },
): Promise<BusinessCalendar> {
  const target =
    ticket.slaPolicy?.targets.find((candidate) => candidate.priorityId === ticket.priorityId) ??
    ticket.slaPolicy?.targets.find((candidate) => candidate.priorityId === null);
  if (!target?.useBusinessHours) return ALWAYS_OPEN;
  return loadCalendar(prisma, organizationId, ticket.slaPolicy?.businessHoursId ?? null);
}

export interface SlaEvent {
  organizationId: string;
  ticketId: string;
  kind: 'warning' | 'breach';
  target: 'first_response' | 'resolution';
}

export interface ScanSlaOptions {
  /**
   * Whether an organization's SLA work may run at all. A denied organization's tickets are
   * left untouched - not stamped, so their warnings and breaches are raised after access is
   * renewed. Asked once per distinct organization by the caller's own memo.
   */
  isOrganizationAllowed?: (organizationId: string) => Promise<boolean>;
  /**
   * Organizations already known to be denied: their tickets are left out of the queries
   * altogether, so a denied organization costs nothing per sweep until it is asked again.
   */
  excludeOrganizationIds?: readonly string[];
}

/**
 * One idempotent sweep: finds targets that are due within their policy's warning
 * window or already past due, stamps them, and returns the events to publish. Running
 * it twice in a row produces no second event because the stamps are the guard.
 */
export async function scanSla(
  prisma: PrismaClient,
  now = new Date(),
  options: ScanSlaOptions = {},
): Promise<SlaEvent[]> {
  const events: SlaEvent[] = [];
  const allowed = options.isOrganizationAllowed;
  const excluded = options.excludeOrganizationIds ?? [];
  const active = {
    ...(excluded.length > 0 ? { organizationId: { notIn: [...excluded] } } : {}),
    deletedAt: null,
    slaPausedAt: null,
    slaPolicyId: { not: null },
    status: { isResolved: false, isClosed: false },
  } as const;

  // Breaches first, so a ticket that is both warned-and-breached in one sweep records
  // the breach and not a stale warning.
  const frBreached = await prisma.ticket.findMany({
    where: { ...active, firstResponseAt: null, firstResponseBreachedAt: null, firstResponseDueAt: { lte: now } },
    select: { id: true, organizationId: true },
  });
  for (const ticket of frBreached) {
    if (allowed && !(await allowed(ticket.organizationId))) continue;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { firstResponseBreachedAt: now } });
    events.push({ organizationId: ticket.organizationId, ticketId: ticket.id, kind: 'breach', target: 'first_response' });
  }

  const resBreached = await prisma.ticket.findMany({
    where: { ...active, resolutionBreachedAt: null, resolutionDueAt: { lte: now } },
    select: { id: true, organizationId: true },
  });
  for (const ticket of resBreached) {
    if (allowed && !(await allowed(ticket.organizationId))) continue;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { resolutionBreachedAt: now } });
    events.push({ organizationId: ticket.organizationId, ticketId: ticket.id, kind: 'breach', target: 'resolution' });
  }

  // Warnings: due within the policy's window, not yet warned, not yet breached.
  const warnable = await prisma.ticket.findMany({
    where: {
      ...active,
      OR: [
        { firstResponseAt: null, firstResponseWarnedAt: null, firstResponseBreachedAt: null, firstResponseDueAt: { gt: now } },
        { resolutionWarnedAt: null, resolutionBreachedAt: null, resolutionDueAt: { gt: now } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      firstResponseAt: true,
      firstResponseWarnedAt: true,
      firstResponseBreachedAt: true,
      firstResponseDueAt: true,
      resolutionWarnedAt: true,
      resolutionBreachedAt: true,
      resolutionDueAt: true,
      slaPolicy: { select: { warningMinutesBefore: true } },
    },
  });
  for (const ticket of warnable) {
    if (allowed && !(await allowed(ticket.organizationId))) continue;
    const windowMs = (ticket.slaPolicy?.warningMinutesBefore ?? 0) * 60_000;
    if (windowMs <= 0) continue;
    const threshold = now.getTime() + windowMs;

    if (
      !ticket.firstResponseAt &&
      !ticket.firstResponseWarnedAt &&
      !ticket.firstResponseBreachedAt &&
      ticket.firstResponseDueAt &&
      ticket.firstResponseDueAt.getTime() <= threshold
    ) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { firstResponseWarnedAt: now } });
      events.push({ organizationId: ticket.organizationId, ticketId: ticket.id, kind: 'warning', target: 'first_response' });
    }
    if (
      !ticket.resolutionWarnedAt &&
      !ticket.resolutionBreachedAt &&
      ticket.resolutionDueAt &&
      ticket.resolutionDueAt.getTime() <= threshold
    ) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { resolutionWarnedAt: now } });
      events.push({ organizationId: ticket.organizationId, ticketId: ticket.id, kind: 'warning', target: 'resolution' });
    }
  }

  return events;
}
