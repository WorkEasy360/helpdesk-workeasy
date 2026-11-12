import {
  PERMISSIONS,
  assignTicketSchema,
  changePrioritySchema,
  changeStatusSchema,
  createMessageSchema,
  resolveTicketSchema,
  type AssistantProposal,
  type AuthenticatedUser,
} from '@digisoft/shared';
import type { TenantPrismaClient } from '@digisoft/db';
import { ticketVisibilityFilter } from '../../tickets/ticket-visibility';

/**
 * Turning the model's suggested `action` into a card the member can confirm — or into a
 * plain reason why it cannot be offered.
 *
 * The shape of every function here follows the blueprint: **parse** (accept only
 * well-formed arguments, clamp them, drop the rest), **verify** (load the record, check
 * its state, run the same validation schema the product's own form uses), **propose**
 * (describe what will happen and name the endpoint that will do it).
 *
 * Nothing in this file writes. The `request` on a proposal is the product's existing
 * endpoint; the browser calls it when the member presses the button, and that endpoint
 * validates, authorises and audits for real. The assistant has no write path.
 */

export type ActionOutcome =
  | { ok: true; proposal: AssistantProposal }
  | { ok: false; reason: string };

export interface ActionContext {
  db: TenantPrismaClient;
  actor: AuthenticatedUser;
}

const can = (actor: AuthenticatedUser, permission: string) => actor.permissions.includes(permission);

function ticketNumberOf(args: Record<string, unknown>): number | null {
  const raw = args['ticketNumber'] ?? args['number'] ?? args['ticket'];
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').replace(/^#/, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const TICKET_SELECT = {
  id: true,
  ticketNumber: true,
  subject: true,
  resolvedAt: true,
  closedAt: true,
  statusId: true,
  priorityId: true,
  assignedAgentId: true,
  departmentId: true,
  status: { select: { id: true, name: true, isResolved: true, isClosed: true } },
  priority: { select: { id: true, name: true } },
  assignedAgent: { select: { id: true, firstName: true, lastName: true } },
} as const;

/** The ticket, if this member is allowed to see it at all. */
async function loadTicket(ctx: ActionContext, number: number) {
  return ctx.db.ticket.findFirst({
    where: { AND: [{ ticketNumber: number }, ticketVisibilityFilter(ctx.actor)] },
    select: TICKET_SELECT,
  });
}

type TicketRow = NonNullable<Awaited<ReturnType<typeof loadTicket>>>;

const ticketPath = (ticket: TicketRow) => `/tickets/${ticket.id}`;
const ticketLabel = (ticket: TicketRow) => `ticket #${ticket.ticketNumber}`;

/**
 * Verifies one proposed action. `kind` has already been matched against the specs the
 * member's role allows, but every check is made again here against the record as it is
 * right now — a ticket resolved a second ago must not get a "resolve" card.
 */
export async function verifyAction(
  action: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  const kind = typeof action['kind'] === 'string' ? action['kind'] : '';
  const handler = HANDLERS[kind];
  if (!handler) {
    return { ok: false, reason: 'That is not something I can prepare for you.' };
  }
  return handler(action, ctx);
}

type Handler = (args: Record<string, unknown>, ctx: ActionContext) => Promise<ActionOutcome>;

/** Loads the ticket named by the action, or explains why it cannot be used. */
async function withTicket(
  args: Record<string, unknown>,
  ctx: ActionContext,
  permission: string,
  run: (ticket: TicketRow) => Promise<ActionOutcome> | ActionOutcome,
): Promise<ActionOutcome> {
  if (!can(ctx.actor, permission)) {
    return { ok: false, reason: 'Your role cannot make that change.' };
  }
  const number = ticketNumberOf(args);
  if (number === null) {
    return { ok: false, reason: 'I could not tell which ticket that was about.' };
  }
  const ticket = await loadTicket(ctx, number);
  if (!ticket) {
    return { ok: false, reason: `There is no ticket #${number} that you can open.` };
  }
  return run(ticket);
}

const HANDLERS: Record<string, Handler> = {
  assign_ticket: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_ASSIGN, async (ticket) => {
      const agentId = id(args['agentId'] ?? args['assignedAgentId']);
      const departmentId = id(args['departmentId']);

      // The endpoint's own schema decides what counts as a valid assignment.
      const parsed = assignTicketSchema.safeParse({
        ...(agentId ? { assignedAgentId: agentId } : {}),
        ...(departmentId ? { departmentId } : {}),
      });
      if (!parsed.success) {
        return { ok: false, reason: 'Name an agent, a department, or both.' };
      }

      const [agent, department] = await Promise.all([
        agentId
          ? ctx.db.user.findFirst({
              where: { id: agentId, type: 'AGENT', isActive: true },
              select: { id: true, firstName: true, lastName: true },
            })
          : null,
        departmentId
          ? ctx.db.department.findFirst({ where: { id: departmentId }, select: { id: true, name: true } })
          : null,
      ]);

      if (agentId && !agent) return { ok: false, reason: 'That agent is not active in this organization.' };
      if (departmentId && !department) return { ok: false, reason: 'That department does not exist here.' };

      const agentName = agent ? `${agent.firstName} ${agent.lastName}`.trim() : null;
      const summary: [string, string][] = [
        ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
        ['Currently', ticket.assignedAgent
          ? `${ticket.assignedAgent.firstName} ${ticket.assignedAgent.lastName}`.trim()
          : 'unassigned'],
      ];
      if (agentName) summary.push(['New assignee', agentName]);
      if (department) summary.push(['Department', department.name]);

      return {
        ok: true,
        proposal: {
          kind: 'assign_ticket',
          title: agentName
            ? `Assign ticket #${ticket.ticketNumber} to ${agentName}`
            : `Move ticket #${ticket.ticketNumber} to ${department?.name}`,
          summary,
          effect: `Assigns ${ticketLabel(ticket)} and notifies whoever it lands on.`,
          confirmLabel: 'Assign',
          danger: false,
          request: { method: 'POST', path: `/tickets/${ticket.id}/assign`, body: parsed.data },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),

  set_ticket_status: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_UPDATE, async (ticket) => {
      const statusId = id(args['statusId']);
      if (!statusId) return { ok: false, reason: 'I need the status id — check the configured statuses first.' };

      const status = await ctx.db.ticketStatus.findFirst({
        where: { id: statusId },
        select: { id: true, name: true, isResolved: true, isClosed: true },
      });
      if (!status) return { ok: false, reason: 'That status does not exist in this organization.' };
      if (status.id === ticket.statusId) {
        return { ok: false, reason: `Ticket #${ticket.ticketNumber} is already ${status.name}.` };
      }

      const resolutionNote = text(args['resolutionNote'], 5_000);
      // The API requires a note when the new status resolves the ticket, so asking the
      // member for one beats offering a card the endpoint would reject.
      if (status.isResolved && !resolutionNote) {
        return {
          ok: false,
          reason: `Moving to ${status.name} resolves the ticket, which needs a resolution note. Ask me again with one.`,
        };
      }

      const parsed = changeStatusSchema.safeParse({
        statusId: status.id,
        ...(resolutionNote ? { resolutionNote } : {}),
      });
      if (!parsed.success) return { ok: false, reason: 'Those status details are not valid.' };

      return {
        ok: true,
        proposal: {
          kind: 'set_ticket_status',
          title: `Move ticket #${ticket.ticketNumber} to ${status.name}`,
          summary: [
            ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
            ['From', ticket.status?.name ?? 'none'],
            ['To', status.name],
            ...(resolutionNote ? ([['Resolution note', resolutionNote]] as [string, string][]) : []),
          ],
          effect: status.isResolved
            ? `Resolves ${ticketLabel(ticket)} and stops its SLA clock.`
            : `Moves ${ticketLabel(ticket)} to ${status.name}.`,
          confirmLabel: `Move to ${status.name}`,
          danger: status.isClosed,
          request: { method: 'POST', path: `/tickets/${ticket.id}/status`, body: parsed.data },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),

  set_ticket_priority: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_UPDATE, async (ticket) => {
      const priorityId = id(args['priorityId']);
      if (!priorityId) return { ok: false, reason: 'I need the priority id — check the configured priorities first.' };

      const priority = await ctx.db.ticketPriority.findFirst({
        where: { id: priorityId },
        select: { id: true, name: true },
      });
      if (!priority) return { ok: false, reason: 'That priority does not exist in this organization.' };
      if (priority.id === ticket.priorityId) {
        return { ok: false, reason: `Ticket #${ticket.ticketNumber} is already ${priority.name}.` };
      }

      const parsed = changePrioritySchema.safeParse({ priorityId: priority.id });
      if (!parsed.success) return { ok: false, reason: 'That priority is not valid.' };

      return {
        ok: true,
        proposal: {
          kind: 'set_ticket_priority',
          title: `Set ticket #${ticket.ticketNumber} to ${priority.name}`,
          summary: [
            ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
            ['From', ticket.priority?.name ?? 'none'],
            ['To', priority.name],
          ],
          // Said plainly because agents routinely expect the opposite.
          effect: `Changes the priority only. SLA targets already set on this ticket do not move.`,
          confirmLabel: 'Change priority',
          danger: false,
          request: { method: 'POST', path: `/tickets/${ticket.id}/priority`, body: parsed.data },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),

  resolve_ticket: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_UPDATE, (ticket) => {
      if (ticket.resolvedAt) {
        return { ok: false, reason: `Ticket #${ticket.ticketNumber} is already resolved.` };
      }
      const resolutionNote = text(args['resolutionNote'] ?? args['note'], 5_000);
      const parsed = resolveTicketSchema.safeParse({ resolutionNote: resolutionNote ?? '' });
      if (!parsed.success) {
        return { ok: false, reason: 'Resolving needs a resolution note. Ask me again with one.' };
      }

      return {
        ok: true,
        proposal: {
          kind: 'resolve_ticket',
          title: `Resolve ticket #${ticket.ticketNumber}`,
          summary: [
            ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
            ['Status', ticket.status?.name ?? 'none'],
            ['Resolution note', parsed.data.resolutionNote],
          ],
          effect: `Resolves ${ticketLabel(ticket)}, stops its SLA clock and may send a satisfaction survey.`,
          confirmLabel: 'Resolve',
          danger: false,
          request: { method: 'POST', path: `/tickets/${ticket.id}/resolve`, body: parsed.data },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),

  reopen_ticket: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_UPDATE, (ticket) => {
      if (!ticket.resolvedAt && !ticket.closedAt) {
        return { ok: false, reason: `Ticket #${ticket.ticketNumber} is already open.` };
      }
      return {
        ok: true,
        proposal: {
          kind: 'reopen_ticket',
          title: `Reopen ticket #${ticket.ticketNumber}`,
          summary: [
            ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
            ['Status', ticket.status?.name ?? 'none'],
          ],
          effect: `Reopens ${ticketLabel(ticket)} and starts its SLA clock again.`,
          confirmLabel: 'Reopen',
          danger: false,
          request: { method: 'POST', path: `/tickets/${ticket.id}/reopen`, body: {} },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),

  add_internal_note: (args, ctx) =>
    withTicket(args, ctx, PERMISSIONS.TICKET_COMMENT, (ticket) => {
      const body = text(args['body'] ?? args['text'] ?? args['note'], 5_000);
      if (!body) return { ok: false, reason: 'Tell me what the note should say.' };

      const parsed = createMessageSchema.safeParse({ bodyText: body });
      if (!parsed.success) return { ok: false, reason: 'That note is not valid.' };

      return {
        ok: true,
        proposal: {
          kind: 'add_internal_note',
          title: `Add an internal note to ticket #${ticket.ticketNumber}`,
          summary: [
            ['Ticket', `#${ticket.ticketNumber} · ${ticket.subject}`],
            ['Note', body],
          ],
          // Spelled out, because the whole risk of this action is confusing it with a reply.
          effect: 'Adds a comment only your colleagues can see. The customer is not notified.',
          confirmLabel: 'Add note',
          danger: false,
          request: { method: 'POST', path: `/tickets/${ticket.id}/comments`, body: parsed.data },
          done: { label: `ticket #${ticket.ticketNumber}`, path: ticketPath(ticket) },
        },
      };
    }),
};
