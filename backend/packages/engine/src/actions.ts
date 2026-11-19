import type { RuleAction } from '@digisoft/shared';
import type { EngineDeps } from './deps';
import { publishRealtime } from './deps';
import { loadTicket, toFacts, type TicketRecord } from './facts';
import { renderTemplate } from './templates';
import { applySla } from './sla';

export interface ActionOutcome {
  type: RuleAction['type'];
  ok: boolean;
  detail?: string;
}

async function notify(
  deps: EngineDeps,
  ticket: TicketRecord,
  userIds: string[],
  message: string,
  type: string,
): Promise<void> {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const notification = await deps.prisma.notification.create({
      data: {
        organizationId: ticket.organizationId,
        userId,
        type,
        title: renderTemplate(message, ticket),
        body: `#${ticket.ticketNumber} · ${ticket.subject}`,
        link: `/tickets/${ticket.id}`,
        data: { ticketId: ticket.id },
      },
    });
    await publishRealtime(deps, {
      organizationId: ticket.organizationId,
      userId,
      event: 'notification.created',
      payload: notification,
    });
  }
}

/**
 * Applies one action to a ticket. Every write names the organization, and every
 * change is audited under the AUTOMATION actor so the history stays honest about who
 * did what.
 */
export async function applyAction(
  deps: EngineDeps,
  ticket: TicketRecord,
  action: RuleAction,
  source: { kind: 'automation' | 'blueprint' | 'escalation'; id: string; name: string },
): Promise<ActionOutcome> {
  const { prisma } = deps;
  const organizationId = ticket.organizationId;
  const audit = async (actionName: string, oldValue: unknown, newValue: unknown) => {
    await prisma.auditLog.create({
      data: {
        organizationId,
        actorType: 'AUTOMATION',
        action: actionName,
        entity: 'Ticket',
        entityId: ticket.id,
        oldValue: oldValue === undefined ? undefined : JSON.parse(JSON.stringify(oldValue)),
        newValue: JSON.parse(JSON.stringify({ ...(newValue as object), by: `${source.kind}:${source.name}` })),
      },
    });
  };

  try {
    switch (action.type) {
      case 'assign_agent': {
        const agent = await prisma.user.findFirst({
          where: { id: action.agentId, organizationId, type: 'AGENT', isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!agent) return { type: action.type, ok: false, detail: 'agent not found' };
        await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedAgentId: agent.id } });
        await prisma.ticketFollower.upsert({
          where: { ticketId_userId: { ticketId: ticket.id, userId: agent.id } },
          create: { ticketId: ticket.id, userId: agent.id },
          update: {},
        });
        await audit('ticket.assigned', { assignedAgentId: ticket.assignedAgentId }, { assignedAgentId: agent.id });
        await notify(deps, ticket, [agent.id], 'Ticket {{ticket.number}} assigned to you', 'ticket.assigned');
        return { type: action.type, ok: true };
      }
      case 'assign_department': {
        const department = await prisma.department.findFirst({
          where: { id: action.departmentId, organizationId, deletedAt: null },
          select: { id: true },
        });
        if (!department) return { type: action.type, ok: false, detail: 'department not found' };
        await prisma.ticket.update({ where: { id: ticket.id }, data: { departmentId: department.id } });
        await audit('ticket.assigned', { departmentId: ticket.departmentId }, { departmentId: department.id });
        return { type: action.type, ok: true };
      }
      case 'unassign': {
        await prisma.ticket.update({ where: { id: ticket.id }, data: { assignedAgentId: null } });
        await audit('ticket.assigned', { assignedAgentId: ticket.assignedAgentId }, { assignedAgentId: null });
        return { type: action.type, ok: true };
      }
      case 'set_priority': {
        const priority = await prisma.ticketPriority.findFirst({
          where: { id: action.priorityId, organizationId },
          select: { id: true, name: true },
        });
        if (!priority) return { type: action.type, ok: false, detail: 'priority not found' };
        await prisma.ticket.update({ where: { id: ticket.id }, data: { priorityId: priority.id } });
        await audit('ticket.priority_changed', { priority: ticket.priority.name }, { priority: priority.name });
        return { type: action.type, ok: true };
      }
      case 'set_status': {
        const status = await prisma.ticketStatus.findFirst({
          where: { id: action.statusId, organizationId },
          select: { id: true, name: true, isResolved: true, isClosed: true },
        });
        if (!status) return { type: action.type, ok: false, detail: 'status not found' };
        const now = new Date();
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            statusId: status.id,
            resolvedAt: status.isResolved ? (ticket.resolvedAt ?? now) : null,
            closedAt: status.isClosed ? now : null,
            resolutionNote: status.isResolved && !ticket.resolutionNote ? `Set by ${source.name}` : undefined,
          },
        });
        await audit('ticket.status_changed', { status: ticket.status.name }, { status: status.name });
        return { type: action.type, ok: true };
      }
      case 'add_tag': {
        const tag = await prisma.tag.findFirst({ where: { id: action.tagId, organizationId }, select: { id: true } });
        if (!tag) return { type: action.type, ok: false, detail: 'tag not found' };
        await prisma.ticketTag.upsert({
          where: { ticketId_tagId: { ticketId: ticket.id, tagId: tag.id } },
          create: { ticketId: ticket.id, tagId: tag.id },
          update: {},
        });
        await audit('ticket.tags_changed', undefined, { added: tag.id });
        return { type: action.type, ok: true };
      }
      case 'remove_tag': {
        await prisma.ticketTag.deleteMany({ where: { ticketId: ticket.id, tagId: action.tagId } });
        await audit('ticket.tags_changed', undefined, { removed: action.tagId });
        return { type: action.type, ok: true };
      }
      case 'apply_sla': {
        const applied = await applySla(prisma, organizationId, ticket.id, toFacts(ticket), ticket.createdAt, action.slaPolicyId);
        if (!applied) return { type: action.type, ok: false, detail: 'policy not applicable' };
        await audit('ticket.sla_applied', undefined, { slaPolicyId: applied.slaPolicyId });
        return { type: action.type, ok: true };
      }
      case 'notify_users': {
        const users = await prisma.user.findMany({
          where: { id: { in: action.userIds }, organizationId, deletedAt: null },
          select: { id: true },
        });
        await notify(deps, ticket, users.map((user) => user.id), action.message, `${source.kind}.notification`);
        return { type: action.type, ok: true, detail: `${users.length} notified` };
      }
      case 'notify_assignee': {
        if (!ticket.assignedAgentId) return { type: action.type, ok: false, detail: 'ticket is unassigned' };
        await notify(deps, ticket, [ticket.assignedAgentId], action.message, `${source.kind}.notification`);
        return { type: action.type, ok: true };
      }
      case 'notify_department': {
        if (!ticket.departmentId) return { type: action.type, ok: false, detail: 'ticket has no department' };
        const members = await prisma.userDepartment.findMany({
          where: { departmentId: ticket.departmentId, user: { organizationId, isActive: true, deletedAt: null } },
          select: { userId: true },
        });
        await notify(deps, ticket, members.map((member) => member.userId), action.message, `${source.kind}.notification`);
        return { type: action.type, ok: true, detail: `${members.length} notified` };
      }
      case 'send_email': {
        const recipients =
          action.to === 'contact'
            ? [ticket.contact?.email].filter((email): email is string => Boolean(email))
            : action.to === 'assignee'
              ? [ticket.assignedAgent?.email].filter((email): email is string => Boolean(email))
              : action.to;
        if (recipients.length === 0) return { type: action.type, ok: false, detail: 'no recipient' };
        const subject = renderTemplate(action.subject, ticket);
        const text = renderTemplate(action.body, ticket);
        for (const to of recipients) {
          await deps.emailQueue.add('send-email', {
            organizationId,
            to,
            subject,
            text,
            html: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
            // An automation's message to a customer is a business effect: the worker checks
            // the organization's Workeasy360 access again right before sending it.
            requiresAccess: true,
          });
        }
        await audit('ticket.email_sent', undefined, { to: recipients, subject });
        return { type: action.type, ok: true, detail: `${recipients.length} queued` };
      }
      case 'add_internal_note': {
        await prisma.ticketMessage.create({
          data: {
            organizationId,
            ticketId: ticket.id,
            type: 'INTERNAL_COMMENT',
            direction: 'OUTBOUND',
            bodyText: `[${source.name}] ${renderTemplate(action.body, ticket)}`,
          },
        });
        await audit('ticket.commented', undefined, { automated: true });
        return { type: action.type, ok: true };
      }
      case 'create_task': {
        const assignedToId =
          action.assignTo === 'assignee' ? ticket.assignedAgentId : (action.assignTo ?? null);
        await prisma.activity.create({
          data: {
            organizationId,
            type: 'TASK',
            subject: renderTemplate(action.subject, ticket),
            ticketId: ticket.id,
            contactId: ticket.contactId,
            accountId: ticket.accountId,
            assignedToId,
            dueAt: action.dueInHours ? new Date(Date.now() + action.dueInHours * 3_600_000) : null,
          },
        });
        await audit('activity.created', undefined, { subject: action.subject });
        return { type: action.type, ok: true };
      }
      default:
        return { type: (action as RuleAction).type, ok: false, detail: 'unknown action' };
    }
  } catch (error) {
    return { type: action.type, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Applies a list in order, reloading the ticket between steps so later actions see earlier ones. */
export async function applyActions(
  deps: EngineDeps,
  organizationId: string,
  ticketId: string,
  actions: RuleAction[],
  source: { kind: 'automation' | 'blueprint' | 'escalation'; id: string; name: string },
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    const ticket = await loadTicket(deps.prisma, organizationId, ticketId);
    if (!ticket) break;
    outcomes.push(await applyAction(deps, ticket, action, source));
  }
  if (outcomes.some((outcome) => outcome.ok)) {
    const ticket = await loadTicket(deps.prisma, organizationId, ticketId);
    if (ticket) {
      await publishRealtime(deps, {
        organizationId,
        audience: { departmentId: ticket.departmentId, assignedAgentId: ticket.assignedAgentId },
        event: 'ticket.updated',
        payload: { id: ticket.id, ticketId: ticket.id },
      });
    }
  }
  return outcomes;
}
