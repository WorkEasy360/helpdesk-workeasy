import type { Queue } from 'bullmq';
import { AUTOMATION_JOB, scanSla, publishRealtime, type EngineDeps, type TriggerJob } from '@digisoft/engine';
import type { AccessGate } from '../access-gate';

/**
 * One SLA sweep. The scan stamps each target the first time it warns or breaches, so
 * repeating the sweep (a retried job, two workers) never fires the same event twice.
 * Built-in behaviour notifies the assignee; anything richer is an escalation rule.
 *
 * Class A (requires active access): the scan is global, so it checks each distinct
 * organization once per sweep and leaves a denied organization's tickets untouched - not
 * stamped, so their warnings and breaches are raised once access is renewed.
 */
export async function handleSlaScan(deps: EngineDeps, automationQueue: Queue<TriggerJob>, gate: AccessGate) {
  const events = await scanSla(deps.prisma, new Date(), {
    isOrganizationAllowed: gate.sweep('sla-scan'),
    excludeOrganizationIds: gate.deniedOrganizations(),
  });

  for (const event of events) {
    const ticket = await deps.prisma.ticket.findFirst({
      where: { id: event.ticketId, organizationId: event.organizationId },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        departmentId: true,
        assignedAgentId: true,
        followers: { select: { userId: true } },
      },
    });
    if (!ticket) continue;

    const label = event.target === 'first_response' ? 'First response' : 'Resolution';
    const title =
      event.kind === 'breach'
        ? `${label} SLA breached on #${ticket.ticketNumber}`
        : `${label} SLA due soon on #${ticket.ticketNumber}`;

    // Warnings go to the assignee; breaches to everyone following the ticket.
    const recipients = new Set<string>();
    if (ticket.assignedAgentId) recipients.add(ticket.assignedAgentId);
    if (event.kind === 'breach') ticket.followers.forEach((follower) => recipients.add(follower.userId));

    for (const userId of recipients) {
      const notification = await deps.prisma.notification.create({
        data: {
          organizationId: event.organizationId,
          userId,
          type: event.kind === 'breach' ? 'sla.breached' : 'sla.warning',
          title,
          body: ticket.subject,
          link: `/tickets/${ticket.id}`,
          data: { ticketId: ticket.id, target: event.target },
        },
      });
      await publishRealtime(deps, { organizationId: event.organizationId, userId, event: 'notification.created', payload: notification });
    }

    await deps.prisma.auditLog.create({
      data: {
        organizationId: event.organizationId,
        actorType: 'SYSTEM',
        action: event.kind === 'breach' ? 'ticket.sla_breached' : 'ticket.sla_warning',
        entity: 'Ticket',
        entityId: ticket.id,
        newValue: { target: event.target },
      },
    });

    await publishRealtime(deps, {
      organizationId: event.organizationId,
      audience: { departmentId: ticket.departmentId, assignedAgentId: ticket.assignedAgentId },
      event: event.kind === 'breach' ? 'sla.breached' : 'sla.warning',
      payload: { ticketId: ticket.id, target: event.target },
    });

    await automationQueue.add(AUTOMATION_JOB, {
      organizationId: event.organizationId,
      ticketId: ticket.id,
      trigger: event.kind === 'breach' ? 'SLA_BREACHED' : 'SLA_WARNING',
      context: { target: event.target },
    });
  }

  if (events.length > 0) deps.log('info', `SLA sweep produced ${events.length} event(s)`);
  return { events: events.length };
}
