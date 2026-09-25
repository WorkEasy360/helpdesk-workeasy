import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, TicketSource } from '@digisoft/db';
import { PERMISSIONS } from '@digisoft/shared';
import type {
  AssignTicketInput,
  AuthenticatedUser,
  BulkTicketResult,
  BulkUpdateTicketsInput,
  BulkUpdateTicketsResponse,
  ChangePriorityInput,
  ChangeStatusInput,
  CreateTicketInput,
  LinkTicketInput,
  ListTicketsQuery,
  MergeTicketInput,
  ResolveTicketInput,
  TicketStatusCategory,
  UpdateTicketInput,
} from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantPrismaClient } from '@digisoft/db';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { orderBy, pageMeta, toSkipTake } from '../common/dto/pagination';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { TicketConfigService } from '../ticket-config/ticket-config.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TicketEventsService } from './ticket-events.service';
import { EngineService } from '../engine/engine.service';
import { AiDispatchService } from '../ai/ai-dispatch.service';
import { CsatService } from '../analytics/csat.service';
import { TICKET_DETAIL_SELECT, TICKET_LIST_SELECT } from './ticket.select';
import { ticketVisibilityFilter } from './ticket-visibility';

const SORTABLE = ['createdAt', 'updatedAt', 'ticketNumber', 'subject', 'dueAt'] as const;

/**
 * "Open" means still needing work: neither resolved nor closed. A resolved ticket
 * leaves the open queue even before it is closed, which is what an agent expects when
 * they pick the Open view.
 */
const OPEN_STATUS: Prisma.TicketWhereInput = { status: { isResolved: false, isClosed: false } };

const STATUS_CATEGORY: Record<TicketStatusCategory, Prisma.TicketWhereInput> = {
  open: OPEN_STATUS,
  // The seeded Closed status is flagged resolved as well, so "resolved" means resolved
  // and not yet closed.
  resolved: { status: { isResolved: true, isClosed: false } },
  closed: { status: { isClosed: true } },
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `createdTo` is inclusive: a bare date runs to the end of that UTC day. */
function createdWithin(from?: string, to?: string): Prisma.TicketWhereInput {
  const createdAt: Prisma.DateTimeFilter<'Ticket'> = {};
  if (from) {
    createdAt.gte = new Date(from);
  }
  if (to && DATE_ONLY.test(to)) {
    createdAt.lt = new Date(new Date(to).getTime() + DAY_MS);
  } else if (to) {
    createdAt.lte = new Date(to);
  }
  return { createdAt };
}

/** A ticket as any channel hands it over, after that channel resolved its references. */
export interface ChannelTicketInput {
  organizationId: string;
  subject: string;
  description: string;
  source: TicketSource;
  /** The configured channel it arrived on, when it came from one. */
  channelId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  departmentId?: string | null;
  assignedAgentId?: string | null;
  categoryId?: string | null;
  statusId?: string | null;
  priorityId?: string | null;
  customFields?: Record<string, unknown> | null;
  tagIds?: string[];
  /** Null for an anonymous web form submission. */
  createdById?: string | null;
  followerUserIds?: string[];
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly config: TicketConfigService,
    private readonly notifications: NotificationsService,
    private readonly events: TicketEventsService,
    private readonly audit: AuditService,
    private readonly engine: EngineService,
    private readonly ai: AiDispatchService,
    private readonly csat: CsatService,
  ) {}

  async list(actor: AuthenticatedUser, query: ListTicketsQuery): Promise<Paginated<unknown>> {
    const where: Prisma.TicketWhereInput = {
      AND: [
        ticketVisibilityFilter(actor),
        {
          ...(query.statusId ? { statusId: query.statusId } : {}),
          ...(query.priorityId ? { priorityId: query.priorityId } : {}),
          ...(query.departmentId ? { departmentId: query.departmentId } : {}),
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(query.contactId ? { contactId: query.contactId } : {}),
          ...(query.accountId ? { accountId: query.accountId } : {}),
          ...(query.source ? { source: query.source } : {}),
          ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
          ...(query.assignedAgentId ? { assignedAgentId: query.assignedAgentId } : {}),
          ...(query.assignedToMe ? { assignedAgentId: actor.id } : {}),
          ...(query.unassigned ? { assignedAgentId: null } : {}),
          ...(query.q ? this.searchFilter(query.q) : {}),
        },
        // Kept as separate clauses: several of these constrain the same relation.
        ...(query.open ? [OPEN_STATUS] : []),
        ...(query.statusCategory ? [STATUS_CATEGORY[query.statusCategory]] : []),
        ...(query.overdue ? [OPEN_STATUS, { dueAt: { lt: new Date() } }] : []),
        ...(query.createdFrom || query.createdTo ? [createdWithin(query.createdFrom, query.createdTo)] : []),
      ],
    };

    const [items, total] = await Promise.all([
      this.db.ticket.findMany({
        where,
        select: TICKET_LIST_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, query.order, 'createdAt'),
        ...toSkipTake(query),
      }),
      this.db.ticket.count({ where }),
    ]);

    return { items, meta: pageMeta(query, total) };
  }

  /** Counts for the saved views in the agent workspace, in one round trip. */
  async summary(actor: AuthenticatedUser) {
    const visible = ticketVisibilityFilter(actor);
    const [total, open, unassigned, assignedToMe, resolved, byStatus] = await Promise.all([
      this.db.ticket.count({ where: visible }),
      this.db.ticket.count({ where: { AND: [visible, OPEN_STATUS] } }),
      this.db.ticket.count({
        where: { AND: [visible, OPEN_STATUS, { assignedAgentId: null }] },
      }),
      this.db.ticket.count({
        where: { AND: [visible, OPEN_STATUS, { assignedAgentId: actor.id }] },
      }),
      this.db.ticket.count({ where: { AND: [visible, { status: { isResolved: true } }] } }),
      this.db.ticket.groupBy({
        by: ['statusId'],
        where: visible,
        _count: { _all: true },
      }),
    ]);

    return { total, open, unassigned, assignedToMe, resolved, byStatus };
  }

  async findById(actor: AuthenticatedUser, id: string) {
    const ticket = await this.db.ticket.findFirst({
      where: { AND: [{ id }, ticketVisibilityFilter(actor)] },
      select: TICKET_DETAIL_SELECT,
    });
    if (!ticket) {
      // Out-of-scope tickets read as missing, so ids stay unguessable.
      throw AppError.notFound('ticket');
    }
    return ticket;
  }

  /** Ownership check used by the message and attachment services. */
  async assertVisible(actor: AuthenticatedUser, ticketId: string): Promise<void> {
    const ticket = await this.db.ticket.findFirst({
      where: { AND: [{ id: ticketId }, ticketVisibilityFilter(actor)] },
      select: { id: true },
    });
    if (!ticket) {
      throw AppError.notFound('ticket');
    }
  }

  async create(actor: AuthenticatedUser, input: CreateTicketInput) {
    await this.assertReferencesExist(input);
    return this.createTicket({
      organizationId: actor.organizationId,
      subject: input.subject,
      description: input.description,
      source: input.source,
      contactId: input.contactId ?? null,
      accountId: input.accountId ?? null,
      departmentId: input.departmentId ?? null,
      assignedAgentId: input.assignedAgentId ?? null,
      categoryId: input.categoryId ?? null,
      statusId: input.statusId ?? null,
      priorityId: input.priorityId ?? null,
      customFields: input.customFields ?? null,
      tagIds: input.tagIds,
      createdById: actor.id,
      followerUserIds: [actor.id],
    });
  }

  /**
   * The one creation path every channel goes through — the agent workspace, the
   * customer portal, a web form, and the inbound channels that come later. It owns
   * the ticket number, the audit entry, assignment routing, the SLA clock and the
   * TICKET_CREATED trigger, so no channel can accidentally skip one of them.
   *
   * References are the caller's responsibility: the agent path validates the ids it
   * was handed, the portal path only passes ids it resolved itself.
   */
  async createTicket(input: ChannelTicketInput) {
    const statusId = input.statusId ?? (await this.config.defaultStatusId());
    const priorityId = input.priorityId ?? (await this.config.defaultPriorityId());
    const accountId = input.accountId ?? (await this.accountIdForContact(input.contactId));
    const followerUserIds = [...new Set(input.followerUserIds ?? [])];

    const created = await this.db.$transaction(async (tx) => {
      // The counter lives on the organization row, so the increment is serialised by
      // the row lock and two concurrent creates cannot share a number.
      const organization = await tx.organization.update({
        where: { id: input.organizationId },
        data: { ticketSequence: { increment: 1 } },
        select: { ticketSequence: true },
      });

      return tx.ticket.create({
        data: {
          organizationId: input.organizationId,
          ticketNumber: organization.ticketSequence,
          subject: input.subject,
          description: input.description,
          source: input.source,
          channelId: input.channelId ?? null,
          contactId: input.contactId ?? null,
          accountId,
          departmentId: input.departmentId ?? null,
          assignedAgentId: input.assignedAgentId ?? null,
          categoryId: input.categoryId ?? null,
          statusId,
          priorityId,
          createdById: input.createdById ?? null,
          customFields: (input.customFields as Prisma.InputJsonValue) ?? undefined,
          tags: { create: (input.tagIds ?? []).map((tagId) => ({ tagId })) },
          followers: { create: followerUserIds.map((userId) => ({ userId })) },
        },
        select: TICKET_DETAIL_SELECT,
      });
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorId: input.createdById ?? null,
      actorType: input.createdById ? 'USER' : 'SYSTEM',
      action: 'ticket.created',
      entity: 'Ticket',
      entityId: created.id,
      newValue: {
        ticketNumber: created.ticketNumber,
        subject: created.subject,
        source: created.source,
      },
    });

    // Assignment rules only route what the caller left unassigned; SLA always applies.
    const routed =
      created.assignedAgent || created.department
        ? null
        : await this.engine.routeNewTicket(input.organizationId, created.id);
    await this.engine.applySlaToTicket(input.organizationId, created.id);

    const ticket = await this.db.ticket.findUniqueOrThrow({
      where: { id: created.id },
      select: TICKET_DETAIL_SELECT,
    });
    this.events.ticketCreated({ organizationId: input.organizationId }, ticket);

    if (ticket.assignedAgent && ticket.assignedAgent.id !== input.createdById) {
      await this.notifyAssignment(
        input.organizationId,
        ticket.id,
        ticket.assignedAgent.id,
        ticket,
      );
    }
    await this.engine.trigger(input.organizationId, ticket.id, 'TICKET_CREATED', {
      routedBy: routed?.ruleName ?? null,
    });
    await this.ai.analyse(input.organizationId, ticket.id, 'TICKET_CREATED');
    return ticket;
  }

  async update(id: string, actor: AuthenticatedUser, input: UpdateTicketInput) {
    const before = await this.findById(actor, id);
    await this.assertReferencesExist(input);

    const ticket = await this.db.ticket.update({
      where: { id },
      data: {
        ...input,
        customFields: (input.customFields as Prisma.InputJsonValue) ?? undefined,
      },
      select: TICKET_DETAIL_SELECT,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.updated',
      entity: 'Ticket',
      entityId: id,
      oldValue: { subject: before.subject, departmentId: before.department?.id ?? null },
      newValue: { subject: ticket.subject, departmentId: ticket.department?.id ?? null },
    });
    this.events.ticketUpdated(actor, ticket);
    await this.engine.trigger(actor.organizationId, id, 'TICKET_UPDATED');
    return ticket;
  }

  async assign(id: string, actor: AuthenticatedUser, input: AssignTicketInput) {
    const before = await this.findById(actor, id);

    if (input.assignedAgentId) {
      await this.assertAgentExists(input.assignedAgentId);
    }
    if (input.departmentId) {
      await this.assertDepartmentExists(input.departmentId);
    }

    const ticket = await this.db.ticket.update({
      where: { id },
      data: {
        ...(input.assignedAgentId !== undefined ? { assignedAgentId: input.assignedAgentId } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      },
      select: TICKET_DETAIL_SELECT,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.assigned',
      entity: 'Ticket',
      entityId: id,
      oldValue: {
        assignedAgentId: before.assignedAgent?.id ?? null,
        departmentId: before.department?.id ?? null,
      },
      newValue: {
        assignedAgentId: ticket.assignedAgent?.id ?? null,
        departmentId: ticket.department?.id ?? null,
      },
    });
    this.events.ticketAssigned(actor, ticket);

    const newAssignee = ticket.assignedAgent?.id;
    if (newAssignee && newAssignee !== before.assignedAgent?.id && newAssignee !== actor.id) {
      await this.notifyAssignment(actor.organizationId, id, newAssignee, ticket);
    }
    await this.engine.trigger(actor.organizationId, id, 'TICKET_ASSIGNED');
    return ticket;
  }

  async changeStatus(id: string, actor: AuthenticatedUser, input: ChangeStatusInput) {
    const before = await this.findById(actor, id);
    const status = await this.db.ticketStatus.findUnique({
      where: { id: input.statusId },
      select: { id: true, name: true, isResolved: true, isClosed: true },
    });
    if (!status) {
      throw AppError.notFound('ticket status');
    }

    if (status.id === before.status.id) {
      return before;
    }

    // A resolution note is required to mark a ticket solved, whichever status the
    // organization has flagged as resolving.
    const resolutionNote = input.resolutionNote ?? before.resolutionNote;
    if (status.isResolved && !resolutionNote) {
      throw AppError.validation('A resolution note is required to resolve a ticket');
    }

    // The governing blueprint, if any, decides whether this move is allowed at all.
    const check = await this.engine.checkStatusChange(actor.organizationId, id, status.id, actor, {
      resolutionNote: input.resolutionNote,
    });
    if (!check.ok) {
      throw AppError.validation(check.reason ?? 'This transition is not allowed', {
        missingFields: check.missingFields ?? [],
      });
    }

    const now = new Date();
    const ticket = await this.db.ticket.update({
      where: { id },
      data: {
        statusId: status.id,
        resolutionNote,
        resolvedAt: status.isResolved ? (before.resolvedAt ?? now) : null,
        closedAt: status.isClosed ? (before.closedAt ?? now) : null,
      },
      select: TICKET_DETAIL_SELECT,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.status_changed',
      entity: 'Ticket',
      entityId: id,
      oldValue: { status: before.status.name },
      newValue: { status: ticket.status.name, ...(check.governed ? { transition: check.transition?.name } : {}) },
    });

    await this.engine.syncSlaPause(actor.organizationId, id, ticket.status.pausesSla);
    if (check.transition) {
      await this.engine.runTransitionActions(actor.organizationId, id, check.transition);
    }

    const fresh = await this.db.ticket.findUniqueOrThrow({ where: { id }, select: TICKET_DETAIL_SELECT });
    this.events.ticketStatusChanged(actor, fresh);
    await this.engine.trigger(actor.organizationId, id, 'STATUS_CHANGED', {
      from: before.status.name,
      to: fresh.status.name,
    });
    // Only the move into a resolved status asks for feedback; resolving an already
    // resolved ticket does not survey the customer twice.
    if (status.isResolved && !before.resolvedAt) {
      await this.csat.onTicketResolved(actor.organizationId, id);
    }
    return fresh;
  }

  async changePriority(id: string, actor: AuthenticatedUser, input: ChangePriorityInput) {
    const before = await this.findById(actor, id);
    const priority = await this.db.ticketPriority.findUnique({
      where: { id: input.priorityId },
      select: { id: true, name: true },
    });
    if (!priority) {
      throw AppError.notFound('ticket priority');
    }

    const ticket = await this.db.ticket.update({
      where: { id },
      data: { priorityId: priority.id },
      select: TICKET_DETAIL_SELECT,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.priority_changed',
      entity: 'Ticket',
      entityId: id,
      oldValue: { priority: before.priority.name },
      newValue: { priority: ticket.priority.name },
    });

    // Targets are per priority, so the clock is re-derived from the original creation time.
    if (!ticket.status.isResolved && !ticket.status.isClosed) {
      await this.engine.applySlaToTicket(actor.organizationId, id);
    }
    const fresh = await this.db.ticket.findUniqueOrThrow({ where: { id }, select: TICKET_DETAIL_SELECT });
    this.events.ticketUpdated(actor, fresh);
    await this.engine.trigger(actor.organizationId, id, 'PRIORITY_CHANGED', {
      from: before.priority.name,
      to: fresh.priority.name,
    });
    return fresh;
  }

  async resolve(id: string, actor: AuthenticatedUser, input: ResolveTicketInput) {
    const status = await this.requireStatusFlag('isResolved', 'resolve');
    return this.changeStatus(id, actor, {
      statusId: status.id,
      resolutionNote: input.resolutionNote,
    });
  }

  async close(id: string, actor: AuthenticatedUser) {
    const status = await this.requireStatusFlag('isClosed', 'close');
    const ticket = await this.findById(actor, id);
    return this.changeStatus(id, actor, {
      statusId: status.id,
      resolutionNote: ticket.resolutionNote ?? 'Closed by agent',
    });
  }

  async reopen(id: string, actor: AuthenticatedUser) {
    const before = await this.findById(actor, id);
    if (!before.status.isResolved && !before.status.isClosed) {
      throw AppError.validation('This ticket is already open');
    }

    const status = await this.db.ticketStatus.findFirst({
      where: { isResolved: false, isClosed: false },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!status) {
      throw AppError.validation('No open status is configured for this organization');
    }

    const ticket = await this.db.ticket.update({
      where: { id },
      data: { statusId: status.id, resolvedAt: null, closedAt: null },
      select: TICKET_DETAIL_SELECT,
    });
    await this.engine.syncSlaPause(actor.organizationId, id, ticket.status.pausesSla);

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.reopened',
      entity: 'Ticket',
      entityId: id,
      oldValue: { status: before.status.name },
      newValue: { status: ticket.status.name },
    });
    this.events.ticketStatusChanged(actor, ticket);
    await this.engine.trigger(actor.organizationId, id, 'STATUS_CHANGED', { from: before.status.name, to: ticket.status.name });
    return ticket;
  }

  /**
   * Applies one action to many tickets, one at a time, through the same methods the
   * single-ticket endpoints use — so visibility, blueprints, the resolution-note rule,
   * audit history, SLA and automation triggers all behave exactly as they do there. A
   * failure is recorded against that ticket and the rest carry on.
   */
  async bulkUpdate(
    actor: AuthenticatedUser,
    input: BulkUpdateTicketsInput,
  ): Promise<BulkUpdateTicketsResponse> {
    // The route asks for ticket.update; (un)assigning also needs what /assign needs.
    if (
      (input.action === 'assign' || input.action === 'unassign') &&
      !actor.permissions.includes(PERMISSIONS.TICKET_ASSIGN)
    ) {
      throw AppError.forbidden(
        `Missing required permission: ${PERMISSIONS.TICKET_ASSIGN}`,
        'PERMISSION_DENIED',
      );
    }

    const results: BulkTicketResult[] = [];
    for (const id of new Set(input.ticketIds)) {
      try {
        await this.applyBulkAction(id, actor, input);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: this.bulkError(id, error) });
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    return { action: input.action, succeeded, failed: results.length - succeeded, results };
  }

  private async applyBulkAction(
    id: string,
    actor: AuthenticatedUser,
    input: BulkUpdateTicketsInput,
  ): Promise<void> {
    switch (input.action) {
      case 'assign':
        await this.assign(id, actor, input.payload);
        return;
      case 'unassign':
        await this.assign(id, actor, { assignedAgentId: null });
        return;
      case 'status':
        await this.changeStatus(id, actor, input.payload);
        return;
      case 'resolve':
        await this.resolve(id, actor, input.payload);
        return;
      case 'close':
        await this.close(id, actor);
        return;
      case 'reopen':
        await this.reopen(id, actor);
        return;
      case 'priority':
        await this.changePriority(id, actor, input.payload);
        return;
      case 'addTags':
      case 'removeTags': {
        const ticket = await this.findById(actor, id);
        const current = ticket.tags.map((entry) => entry.tag.id);
        const change = new Set(input.payload.tagIds);
        const next =
          input.action === 'addTags'
            ? [...new Set([...current, ...input.payload.tagIds])]
            : current.filter((tagId) => !change.has(tagId));
        if (next.length === current.length && next.every((tagId) => current.includes(tagId))) {
          return;
        }
        await this.setTags(id, actor, next);
        return;
      }
    }
  }

  private bulkError(id: string, error: unknown): { code: string; message: string } {
    if (error instanceof AppError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof HttpException) {
      return { code: 'VALIDATION_ERROR', message: error.message };
    }
    this.logger.error(`Bulk update failed for ticket ${id}`, error instanceof Error ? error.stack : error);
    return { code: 'INTERNAL_ERROR', message: 'Something went wrong updating this ticket' };
  }

  /** Blueprint transitions the actor may take from the ticket's current status. */
  async transitions(id: string, actor: AuthenticatedUser) {
    await this.assertVisible(actor, id);
    return this.engine.transitionsFor(actor.organizationId, id, actor);
  }

  async setTags(id: string, actor: AuthenticatedUser, tagIds: string[]) {
    await this.findById(actor, id);
    if (tagIds.length > 0) {
      const found = await this.db.tag.count({ where: { id: { in: tagIds } } });
      if (found !== new Set(tagIds).size) {
        throw AppError.validation('One or more tags do not exist in this organization');
      }
    }

    const ticket = await this.db.$transaction(async (tx) => {
      await tx.ticketTag.deleteMany({ where: { ticketId: id } });
      if (tagIds.length > 0) {
        await tx.ticketTag.createMany({ data: tagIds.map((tagId) => ({ ticketId: id, tagId })) });
      }
      return tx.ticket.findUniqueOrThrow({ where: { id }, select: TICKET_DETAIL_SELECT });
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.tags_changed',
      entity: 'Ticket',
      entityId: id,
      newValue: { tagIds },
    });
    this.events.ticketUpdated(actor, ticket);
    return ticket;
  }

  /**
   * Folds this ticket into another: the conversation moves across, and the source is
   * closed with a pointer to the survivor so its history is never lost.
   */
  async merge(id: string, actor: AuthenticatedUser, input: MergeTicketInput) {
    if (id === input.targetTicketId) {
      throw AppError.validation('A ticket cannot be merged into itself');
    }
    const source = await this.findById(actor, id);
    const target = await this.findById(actor, input.targetTicketId);
    if (source.mergedIntoTicketId) {
      throw AppError.validation('This ticket has already been merged');
    }

    const closedStatus = await this.requireStatusFlag('isClosed', 'close');
    const now = new Date();

    await this.db.$transaction(async (tx) => {
      await tx.ticketMessage.updateMany({
        where: { ticketId: id },
        data: { ticketId: target.id },
      });
      await tx.attachment.updateMany({
        where: { ticketId: id },
        data: { ticketId: target.id },
      });
      await tx.ticketMessage.create({
        data: {
          organizationId: actor.organizationId,
          ticketId: target.id,
          type: 'SYSTEM_NOTE',
          bodyText:
            `Ticket #${source.ticketNumber} (${source.subject}) was merged into this ticket` +
            (input.comment ? `: ${input.comment}` : '.'),
          authorUserId: actor.id,
        },
      });
      await tx.ticket.update({
        where: { id },
        data: {
          mergedIntoTicketId: target.id,
          statusId: closedStatus.id,
          closedAt: now,
          resolvedAt: source.resolvedAt ?? now,
          resolutionNote: source.resolutionNote ?? `Merged into #${target.ticketNumber}`,
        },
      });
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.merged',
      entity: 'Ticket',
      entityId: id,
      newValue: { mergedInto: target.ticketNumber },
    });

    const merged = await this.findById(actor, target.id);
    this.events.ticketUpdated(actor, merged);
    return merged;
  }

  async link(id: string, actor: AuthenticatedUser, input: LinkTicketInput) {
    if (id === input.linkedTicketId) {
      throw AppError.validation('A ticket cannot be linked to itself');
    }
    await this.findById(actor, id);
    await this.findById(actor, input.linkedTicketId);

    const existing = await this.db.ticketLink.findFirst({
      where: { ticketId: id, linkedTicketId: input.linkedTicketId },
      select: { id: true },
    });
    if (existing) {
      throw AppError.conflict('These tickets are already linked');
    }

    await this.db.ticketLink.create({
      data: {
        organizationId: actor.organizationId,
        ticketId: id,
        linkedTicketId: input.linkedTicketId,
        type: input.type,
      },
    });
    return this.findById(actor, id);
  }

  async unlink(id: string, actor: AuthenticatedUser, linkId: string) {
    await this.findById(actor, id);
    await this.db.ticketLink.deleteMany({ where: { id: linkId, ticketId: id } });
    return this.findById(actor, id);
  }

  async follow(id: string, actor: AuthenticatedUser, follow: boolean) {
    await this.findById(actor, id);
    if (follow) {
      await this.db.ticketFollower.upsert({
        where: { ticketId_userId: { ticketId: id, userId: actor.id } },
        create: { ticketId: id, userId: actor.id },
        update: {},
      });
    } else {
      await this.db.ticketFollower.deleteMany({ where: { ticketId: id, userId: actor.id } });
    }
    return { following: follow };
  }

  /** Change history, read from the audit log rather than a duplicate table. */
  async history(id: string, actor: AuthenticatedUser, query: { page: number; pageSize: number }) {
    await this.assertVisible(actor, id);
    const where = { entity: 'Ticket', entityId: id };

    const [entries, total] = await Promise.all([
      this.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          action: true,
          actorId: true,
          actorType: true,
          oldValue: true,
          newValue: true,
          createdAt: true,
        },
        ...toSkipTake(query),
      }),
      this.db.auditLog.count({ where }),
    ]);

    const actorIds = [...new Set(entries.map((entry) => entry.actorId).filter(Boolean))] as string[];
    const actors = await this.db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(actors.map((user) => [user.id, user]));

    return {
      items: entries.map((entry) => ({
        ...entry,
        actor: entry.actorId ? (byId.get(entry.actorId) ?? null) : null,
      })),
      meta: pageMeta(query, total),
    };
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    await this.findById(actor, id);
    await this.db.ticket.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.deleted',
      entity: 'Ticket',
      entityId: id,
    });
  }

  private searchFilter(term: string): Prisma.TicketWhereInput {
    const asNumber = Number.parseInt(term.replace(/^#/, ''), 10);
    return {
      OR: [
        { subject: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        ...(Number.isFinite(asNumber) ? [{ ticketNumber: asNumber }] : []),
      ],
    };
  }

  private async notifyAssignment(
    organizationId: string,
    ticketId: string,
    assigneeId: string,
    ticket: { ticketNumber: number; subject: string },
  ): Promise<void> {
    await this.notifications.create(organizationId, {
      userId: assigneeId,
      type: 'ticket.assigned',
      title: `Ticket #${ticket.ticketNumber} assigned to you`,
      body: ticket.subject,
      link: `/tickets/${ticketId}`,
      data: { ticketId },
    });
    await this.db.ticketFollower.upsert({
      where: { ticketId_userId: { ticketId, userId: assigneeId } },
      create: { ticketId, userId: assigneeId },
      update: {},
    });
  }

  private async requireStatusFlag(flag: 'isResolved' | 'isClosed', action: string) {
    const status = await this.db.ticketStatus.findFirst({
      where: { [flag]: true },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!status) {
      throw AppError.validation(
        `No status is configured to ${action} a ticket in this organization`,
      );
    }
    return status;
  }

  private async accountIdForContact(contactId: string | null | undefined) {
    if (!contactId) {
      return null;
    }
    const contact = await this.db.contact.findUnique({
      where: { id: contactId },
      select: { accountId: true },
    });
    return contact?.accountId ?? null;
  }

  private async assertReferencesExist(
    input: Partial<CreateTicketInput> & { assignedAgentId?: string | null },
  ): Promise<void> {
    if (input.contactId) {
      const contact = await this.db.contact.findUnique({
        where: { id: input.contactId },
        select: { id: true },
      });
      if (!contact) throw AppError.notFound('contact');
    }
    if (input.accountId) {
      const account = await this.db.account.findUnique({
        where: { id: input.accountId },
        select: { id: true },
      });
      if (!account) throw AppError.notFound('account');
    }
    if (input.departmentId) {
      await this.assertDepartmentExists(input.departmentId);
    }
    if (input.assignedAgentId) {
      await this.assertAgentExists(input.assignedAgentId);
    }
    if (input.categoryId) {
      const category = await this.db.ticketCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      });
      if (!category) throw AppError.notFound('ticket category');
    }
    if (input.statusId) {
      const status = await this.db.ticketStatus.findUnique({
        where: { id: input.statusId },
        select: { id: true },
      });
      if (!status) throw AppError.notFound('ticket status');
    }
    if (input.priorityId) {
      const priority = await this.db.ticketPriority.findUnique({
        where: { id: input.priorityId },
        select: { id: true },
      });
      if (!priority) throw AppError.notFound('ticket priority');
    }
    if (input.tagIds && input.tagIds.length > 0) {
      const found = await this.db.tag.count({ where: { id: { in: input.tagIds } } });
      if (found !== new Set(input.tagIds).size) {
        throw AppError.validation('One or more tags do not exist in this organization');
      }
    }
  }

  private async assertAgentExists(userId: string): Promise<void> {
    const agent = await this.db.user.findFirst({
      where: { id: userId, type: 'AGENT', isActive: true },
      select: { id: true },
    });
    if (!agent) {
      throw AppError.notFound('agent');
    }
  }

  private async assertDepartmentExists(departmentId: string): Promise<void> {
    const department = await this.db.department.findUnique({
      where: { id: departmentId },
      select: { id: true },
    });
    if (!department) {
      throw AppError.notFound('department');
    }
  }
}
