import { PERMISSIONS, type AuthenticatedUser } from '@digisoft/shared';
import type { TenantPrismaClient } from '@digisoft/db';
import type { AssistantToolOutcome } from '@digisoft/ai';
import { ticketVisibilityFilter } from '../../tickets/ticket-visibility';

/**
 * A status has no category column — it carries `isResolved` / `isClosed` flags, and the
 * ticket list derives the four categories from them. The same derivation is used here
 * so the assistant's counts match what the member sees on the Tickets page.
 */
const STATUS_CATEGORY: Record<string, Record<string, unknown>> = {
  OPEN: { status: { isResolved: false, isClosed: false } },
  PENDING: { status: { pausesSla: true, isResolved: false, isClosed: false } },
  RESOLVED: { status: { isResolved: true, isClosed: false } },
  CLOSED: { status: { isClosed: true } },
};

function categoryOf(status: { isResolved: boolean; isClosed: boolean; pausesSla: boolean } | null): string {
  if (!status) return 'unknown';
  if (status.isClosed) return 'closed';
  if (status.isResolved) return 'resolved';
  return status.pausesSla ? 'pending' : 'open';
}

/**
 * The read-only lookups behind `ASSISTANT_TOOLS`.
 *
 * Three rules hold for every runner here, and the tests check them:
 *
 * - **The permission is re-checked**, even though the model was only told about tools
 *   the role could use. A role changed mid-conversation takes effect on the next call.
 * - **Ticket visibility is the same filter the ticket list uses**, so an agent without
 *   `ticket.read.all` sees their own and their departments' queues here too.
 * - **Loose input is tolerated, never fatal.** Unknown arguments are ignored and limits
 *   are clamped, because a model that mistypes an argument should still get an answer.
 */

export interface ToolContext {
  db: TenantPrismaClient;
  actor: AuthenticatedUser;
  /** The organization's timezone, for "today". */
  timezone: string;
}

type ToolRunner = (args: Record<string, unknown>, ctx: ToolContext) => Promise<AssistantToolOutcome>;

const can = (actor: AuthenticatedUser, permission: string) => actor.permissions.includes(permission);

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

function asText(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : undefined;
}

function asTicketNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').replace(/^#/, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

/** How a ticket's SLA reads to a human, without exposing raw target rows. */
function slaState(ticket: {
  slaPolicyId: string | null;
  resolvedAt: Date | null;
  slaPausedAt: Date | null;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolutionDueAt: Date | null;
  resolutionBreachedAt: Date | null;
}): string {
  if (!ticket.slaPolicyId) return 'no SLA policy';
  if (ticket.resolvedAt) return 'resolved';
  if (ticket.slaPausedAt) return 'paused';
  const awaitingFirst = !ticket.firstResponseAt;
  const breached = awaitingFirst ? ticket.firstResponseBreachedAt : ticket.resolutionBreachedAt;
  const due = awaitingFirst ? ticket.firstResponseDueAt : ticket.resolutionDueAt;
  const label = awaitingFirst ? 'first response' : 'resolution';
  if (breached) {
    const mins = Math.round((Date.now() - breached.getTime()) / 60_000);
    return `${label} breached ${mins} minutes ago`;
  }
  if (!due) return `${label} target not set`;
  const mins = Math.round((due.getTime() - Date.now()) / 60_000);
  return mins >= 0 ? `${label} due in ${mins} minutes` : `${label} overdue by ${Math.abs(mins)} minutes`;
}

const TICKET_SELECT = {
  id: true,
  ticketNumber: true,
  subject: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  slaPolicyId: true,
  slaPausedAt: true,
  firstResponseAt: true,
  firstResponseDueAt: true,
  firstResponseBreachedAt: true,
  resolutionDueAt: true,
  resolutionBreachedAt: true,
  status: { select: { id: true, name: true, isResolved: true, isClosed: true, pausesSla: true } },
  priority: { select: { id: true, name: true } },
  assignedAgent: { select: { id: true, firstName: true, lastName: true } },
  department: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

type TicketRow = {
  id: string;
  ticketNumber: number;
  subject: string;
  updatedAt: Date;
  status: { id: string; name: string; isResolved: boolean; isClosed: boolean; pausesSla: boolean } | null;
  priority: { id: string; name: string } | null;
  assignedAgent: { id: string; firstName: string; lastName: string } | null;
  contact: { id: string; firstName: string; lastName: string | null } | null;
} & Parameters<typeof slaState>[0];

const shapeTicket = (ticket: TicketRow) => ({
  id: ticket.id,
  number: ticket.ticketNumber,
  subject: ticket.subject,
  status: ticket.status?.name ?? 'unknown',
  statusCategory: categoryOf(ticket.status),
  priority: ticket.priority?.name ?? 'none',
  assignee: ticket.assignedAgent
    ? `${ticket.assignedAgent.firstName} ${ticket.assignedAgent.lastName}`.trim()
    : null,
  requester: ticket.contact
    ? `${ticket.contact.firstName} ${ticket.contact.lastName ?? ''}`.trim()
    : null,
  sla: slaState(ticket),
  updatedAt: ticket.updatedAt.toISOString(),
});

export const ASSISTANT_TOOL_RUNNERS: Record<string, ToolRunner> = {
  /** Always available; the counts inside it are filtered by what the role can see. */
  async helpdesk_overview(_args, { db, actor, timezone }) {
    const organization = await db.organization.findFirst({
      select: { name: true, slug: true, timezone: true },
    });

    const base: Record<string, unknown> = {
      organization: organization?.name ?? 'this organization',
      timezone: organization?.timezone ?? timezone,
      today: new Date().toISOString().slice(0, 10),
      you: `${actor.firstName} ${actor.lastName}`.trim(),
      yourRoles: actor.roles,
    };

    if (can(actor, PERMISSIONS.TICKET_READ)) {
      const visible = ticketVisibilityFilter(actor);
      const [open, unassigned, mine, overdue] = await Promise.all([
        db.ticket.count({ where: { AND: [visible, STATUS_CATEGORY['OPEN'] as never] } }),
        db.ticket.count({ where: { AND: [visible, { assignedAgentId: null, resolvedAt: null }] } }),
        db.ticket.count({ where: { AND: [visible, { assignedAgentId: actor.id, resolvedAt: null }] } }),
        db.ticket.count({
          where: {
            AND: [
              visible,
              { resolvedAt: null },
              { OR: [{ firstResponseBreachedAt: { not: null } }, { resolutionBreachedAt: { not: null } }] },
            ],
          },
        }),
      ]);
      base['tickets'] = { open, unassigned, assignedToYou: mine, breached: overdue };
    } else {
      base['tickets'] = 'you cannot read tickets in this organization';
    }

    if (can(actor, PERMISSIONS.CONTACT_READ)) {
      base['contacts'] = await db.contact.count();
    }
    if (can(actor, PERMISSIONS.USER_READ)) {
      base['agents'] = await db.user.count({ where: { type: 'AGENT', isActive: true } });
    }

    return { ok: true, result: base };
  },

  async search_tickets(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.TICKET_READ)) {
      return { ok: false, error: 'You cannot read tickets in this organization.' };
    }
    const limit = clampLimit(args['limit'], 10, 20);
    const query = asText(args['query']);
    const view = asText(args['view']);
    const statusCategory = asText(args['statusCategory'])?.toUpperCase();

    const where: Record<string, unknown>[] = [ticketVisibilityFilter(actor)];
    if (query) {
      where.push({
        OR: [
          { subject: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      });
    }
    if (view === 'mine') where.push({ assignedAgentId: actor.id, resolvedAt: null });
    if (view === 'unassigned') where.push({ assignedAgentId: null, resolvedAt: null });
    if (view === 'open') where.push(STATUS_CATEGORY['OPEN'] as never);
    if (view === 'overdue') {
      where.push({
        resolvedAt: null,
        OR: [{ firstResponseBreachedAt: { not: null } }, { resolutionBreachedAt: { not: null } }],
      });
    }
    const category = statusCategory ? STATUS_CATEGORY[statusCategory] : undefined;
    if (category) where.push(category);

    const tickets = await db.ticket.findMany({
      where: { AND: where as never },
      select: TICKET_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return {
      ok: true,
      result: { count: tickets.length, tickets: tickets.map((t) => shapeTicket(t as TicketRow)) },
    };
  },

  async get_ticket(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.TICKET_READ)) {
      return { ok: false, error: 'You cannot read tickets in this organization.' };
    }
    const number = asTicketNumber(args['ticketNumber'] ?? args['number']);
    if (number === undefined) {
      return { ok: false, error: 'Give the ticket number, for example {"ticketNumber": 214}.' };
    }

    const ticket = await db.ticket.findFirst({
      where: { AND: [{ ticketNumber: number }, ticketVisibilityFilter(actor)] },
      select: {
        ...TICKET_SELECT,
        description: true,
        category: { select: { id: true, name: true } },
        tags: { select: { tag: { select: { id: true, name: true } } } },
        messages: {
          select: { id: true, type: true, bodyText: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!ticket) {
      return { ok: false, error: `No ticket #${number} that you can see.` };
    }

    return {
      ok: true,
      result: {
        ...shapeTicket(ticket as TicketRow),
        description: ticket.description?.slice(0, 1_500) ?? '',
        category: ticket.category?.name ?? null,
        department: ticket.department?.name ?? null,
        tags: ticket.tags.map((row) => row.tag.name),
        // Marked as what it is: text other people wrote.
        recentMessages: ticket.messages.reverse().map((message) => ({
          at: message.createdAt.toISOString(),
          internal: message.type === 'INTERNAL_COMMENT',
          text: (message.bodyText ?? '').slice(0, 800),
        })),
      },
    };
  },

  async list_ticket_options(_args, { db, actor }) {
    if (!can(actor, PERMISSIONS.TICKET_READ)) {
      return { ok: false, error: 'You cannot read tickets in this organization.' };
    }
    const [statuses, priorities, categories, tags] = await Promise.all([
      db.ticketStatus.findMany({
        select: { id: true, name: true, isResolved: true, isClosed: true, pausesSla: true, isDefault: true },
        orderBy: { position: 'asc' },
      }),
      db.ticketPriority.findMany({ select: { id: true, name: true }, orderBy: { position: 'asc' } }),
      db.ticketCategory.findMany({ select: { id: true, name: true }, take: 40 }),
      db.tag.findMany({ select: { id: true, name: true }, take: 40 }),
    ]);
    return { ok: true, result: { statuses, priorities, categories, tags } };
  },

  async list_agents(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.USER_READ)) {
      return { ok: false, error: 'You cannot read the agent list in this organization.' };
    }
    const limit = clampLimit(args['limit'], 10, 20);
    const query = asText(args['query']);

    const agents = await db.user.findMany({
      where: {
        type: 'AGENT',
        isActive: true,
        ...(query
          ? {
              OR: [
                { firstName: { contains: query, mode: 'insensitive' } },
                { lastName: { contains: query, mode: 'insensitive' } },
                { email: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        _count: { select: { assignedTickets: { where: { resolvedAt: null } } } },
      },
      take: limit,
    });

    const departments = await db.department.findMany({
      select: { id: true, name: true },
      take: 20,
    });

    return {
      ok: true,
      result: {
        agents: agents.map((agent) => ({
          id: agent.id,
          name: `${agent.firstName} ${agent.lastName}`.trim(),
          openTickets: agent._count.assignedTickets,
        })),
        departments,
      },
    };
  },

  async search_contacts(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.CONTACT_READ)) {
      return { ok: false, error: 'You cannot read contacts in this organization.' };
    }
    const limit = clampLimit(args['limit'], 10, 20);
    const query = asText(args['query']);

    const contacts = await db.contact.findMany({
      where: query
        ? {
            OR: [
              { firstName: { contains: query, mode: 'insensitive' } },
              { lastName: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {},
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        account: { select: { id: true, name: true } },
        _count: { select: { tickets: { where: { resolvedAt: null } } } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return {
      ok: true,
      result: contacts.map((contact) => ({
        id: contact.id,
        name: `${contact.firstName} ${contact.lastName ?? ''}`.trim(),
        // The address is how an agent identifies a requester; phone and postal
        // address are deliberately not returned.
        email: contact.email,
        account: contact.account?.name ?? null,
        openTickets: contact._count.tickets,
      })),
    };
  },

  async search_articles(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.KB_READ)) {
      return { ok: false, error: 'You cannot read the knowledge base in this organization.' };
    }
    const limit = clampLimit(args['limit'], 5, 10);
    const query = asText(args['query'], 200);
    if (!query) {
      return { ok: false, error: 'Give something to search for, for example {"query": "password reset"}.' };
    }

    const articles = await db.kbArticle.findMany({
      where: {
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { summary: { contains: query, mode: 'insensitive' } },
          { body: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, title: true, summary: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return {
      ok: true,
      result: articles.map((article) => ({
        id: article.id,
        title: article.title,
        extract: article.summary?.slice(0, 300) ?? null,
        published: article.status === 'PUBLISHED',
      })),
    };
  },

  async ticket_metrics(args, { db, actor }) {
    if (!can(actor, PERMISSIONS.REPORT_READ)) {
      return { ok: false, error: 'You cannot read reports in this organization.' };
    }
    const range = asText(args['range']) ?? '30d';
    const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '90d' ? 90 : 30;
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);

    const visible = ticketVisibilityFilter(actor);
    const [created, resolved, breached, csat] = await Promise.all([
      db.ticket.count({ where: { AND: [visible, { createdAt: { gte: since } }] } }),
      db.ticket.count({ where: { AND: [visible, { resolvedAt: { gte: since } }] } }),
      db.ticket.count({
        where: {
          AND: [
            visible,
            { createdAt: { gte: since } },
            { OR: [{ firstResponseBreachedAt: { not: null } }, { resolutionBreachedAt: { not: null } }] },
          ],
        },
      }),
      db.csatResponse.aggregate({
        where: { respondedAt: { gte: since } },
        _avg: { rating: true },
        _count: { _all: true },
      }),
    ]);

    return {
      ok: true,
      result: {
        range: `${days} day(s) to today`,
        created,
        resolved,
        breachedSla: breached,
        slaCompliance: created > 0 ? `${Math.round(((created - breached) / created) * 100)}%` : null,
        csatAverage: csat._avg.rating !== null ? Number(csat._avg.rating.toFixed(2)) : null,
        csatResponses: csat._count._all,
      },
    };
  },
};
