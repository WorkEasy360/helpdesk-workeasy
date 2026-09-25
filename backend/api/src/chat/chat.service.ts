import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Prisma, TenantPrismaClient } from '@digisoft/db';
import type {
  AuthenticatedUser,
  ChatMessageInput,
  ListChatSessionsQuery,
  StartChatInput,
} from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AppError } from '../common/errors/app-error';
import { pageMeta, toSkipTake } from '../common/dto/pagination';
import type { Paginated } from '../common/interceptors/response.interceptor';
import { TicketsService } from '../tickets/tickets.service';
import { TicketMessagesService } from '../tickets/ticket-messages.service';
import { AuditService } from '../audit/audit.service';
import { CHAT_BRIDGE_CHANNEL, CHAT_EVENTS, chatRoom } from './chat.events';
import { RT_BRIDGE_CHANNEL } from '../realtime/realtime.bridge';
import { AppConfig } from '../config/config.module';
import { allowedOriginsOf, isWidgetOriginAllowed } from './widget-origin';

const SESSION_SELECT = {
  id: true,
  status: true,
  visitorName: true,
  visitorEmail: true,
  pageUrl: true,
  startedAt: true,
  lastSeenAt: true,
  endedAt: true,
  rating: true,
  ticketId: true,
  contactId: true,
  ticket: {
    select: {
      id: true,
      ticketNumber: true,
      subject: true,
      status: { select: { id: true, name: true, color: true } },
      assignedAgent: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} as const;

const MESSAGE_SELECT = {
  id: true,
  bodyText: true,
  direction: true,
  createdAt: true,
  authorUser: { select: { id: true, firstName: true, lastName: true } },
  authorContact: { select: { id: true, firstName: true, lastName: true } },
} as const;

export const hashChatToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Live chat. A conversation is an ordinary ticket from the first message, so SLA,
 * automation, assignment and the agent workspace apply to chat exactly as they do to
 * email — the session row only carries what is specific to a live visit.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tickets: TicketsService,
    private readonly messages: TicketMessagesService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Refuses a browser request from a site the chat channel does not list in
   * `allowedOrigins`. CORS on these routes is open so any embedding site can reach them;
   * this is where the channel's own list is enforced.
   */
  async assertWidgetOrigin(origin: string | undefined): Promise<void> {
    const channel = await this.channel();
    if (!channel) {
      return;
    }
    if (!isWidgetOriginAllowed(origin, this.config.get('FRONTEND_URL'), allowedOriginsOf(channel.config))) {
      throw AppError.forbidden('This site is not allowed to use this chat widget');
    }
  }

  /** The chat channel configured for this organization, if any. */
  async channel() {
    return this.db.channel.findFirst({
      where: { type: 'CHAT', isActive: true },
      select: {
        id: true,
        name: true,
        config: true,
        departmentId: true,
        priorityId: true,
        categoryId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async start(
    organizationId: string,
    input: StartChatInput,
    meta: { ip: string | null; userAgent: string | null; contactId?: string | null },
  ) {
    const channel = await this.channel();
    if (!channel) {
      throw AppError.validation('Live chat is not switched on for this help center');
    }

    const contactId = meta.contactId ?? (await this.resolveContact(organizationId, input));
    const token = randomBytes(24).toString('base64url');

    const ticket = await this.tickets.createTicket({
      organizationId,
      subject: input.message.slice(0, 120) || 'Live chat',
      description: input.message,
      source: 'CHAT',
      channelId: channel.id,
      contactId,
      departmentId: channel.departmentId,
      priorityId: channel.priorityId,
      categoryId: channel.categoryId,
    });

    const session = await this.db.chatSession.create({
      data: {
        organizationId,
        channelId: channel.id,
        ticketId: ticket.id,
        contactId,
        tokenHash: hashChatToken(token),
        visitorName: input.name ?? null,
        visitorEmail: input.email ?? null,
        pageUrl: input.pageUrl ?? null,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
      select: SESSION_SELECT,
    });

    await this.db.ticketMessage.create({
      data: {
        organizationId,
        ticketId: ticket.id,
        type: 'PUBLIC_REPLY',
        direction: 'INBOUND',
        authorContactId: contactId,
        bodyText: input.message,
        channel: 'CHAT',
      },
    });

    await this.audit.record({
      organizationId,
      actorType: 'SYSTEM',
      action: 'chat.started',
      entity: 'ChatSession',
      entityId: session.id,
      newValue: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
    });

    // Agents watching the chat inbox see it the moment it is queued: chat events go to
    // the visitor's room, and the same event goes to the organization's agent sockets.
    const started = {
      sessionId: session.id,
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      visitorName: session.visitorName,
    };
    await this.publish(organizationId, session.id, CHAT_EVENTS.STARTED, started);
    await this.redis.publish(
      RT_BRIDGE_CHANNEL,
      JSON.stringify({ organizationId, event: CHAT_EVENTS.STARTED, payload: started }),
    );

    const config = (channel.config ?? {}) as Record<string, unknown>;
    return {
      token,
      session,
      greeting: typeof config['greeting'] === 'string' ? config['greeting'] : null,
    };
  }

  /** Loads a session from the visitor's token; the token itself is never stored. */
  async fromToken(token: string) {
    const session = await this.db.chatSession.findFirst({
      where: { tokenHash: hashChatToken(token) },
      select: { ...SESSION_SELECT, organizationId: true },
    });
    if (!session) {
      throw AppError.unauthenticated('This chat session is no longer valid');
    }
    return session;
  }

  async transcript(sessionId: string) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId },
      select: SESSION_SELECT,
    });
    if (!session?.ticketId) {
      throw AppError.notFound('chat session');
    }
    const messages = await this.db.ticketMessage.findMany({
      where: { ticketId: session.ticketId, type: { not: 'INTERNAL_COMMENT' } },
      select: MESSAGE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return { session, messages };
  }

  /** A line typed by the visitor. */
  async visitorMessage(
    organizationId: string,
    sessionId: string,
    input: ChatMessageInput,
  ) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId },
      select: { id: true, status: true, ticketId: true, contactId: true },
    });
    if (!session?.ticketId) {
      throw AppError.notFound('chat session');
    }
    if (session.status === 'ENDED') {
      throw AppError.validation('This chat has ended');
    }

    const message = await this.messages.addInboundMessage({
      organizationId,
      ticketId: session.ticketId,
      contactId: session.contactId,
      bodyText: input.body,
      channel: 'CHAT',
    });

    await this.db.chatSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() },
    });

    await this.publish(organizationId, sessionId, CHAT_EVENTS.MESSAGE, {
      sessionId,
      id: message.id,
      body: input.body,
      direction: 'INBOUND',
      createdAt: new Date().toISOString(),
    });

    return message;
  }

  async end(organizationId: string, sessionId: string, rating?: number) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId },
      select: { id: true, status: true },
    });
    if (!session) {
      throw AppError.notFound('chat session');
    }
    const updated = await this.db.chatSession.update({
      where: { id: sessionId },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        ...(rating ? { rating } : {}),
      },
      select: SESSION_SELECT,
    });
    await this.publish(organizationId, sessionId, CHAT_EVENTS.ENDED, { sessionId });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Agent side
  // -------------------------------------------------------------------------

  async list(query: ListChatSessionsQuery): Promise<Paginated<unknown>> {
    const where: Prisma.ChatSessionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.chatSession.findMany({
        where,
        select: SESSION_SELECT,
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
        ...toSkipTake(query),
      }),
      this.db.chatSession.count({ where }),
    ]);
    return { items, meta: pageMeta(query, total) };
  }

  /** An agent picks up a queued chat: the ticket is assigned to them at the same time. */
  async accept(sessionId: string, actor: AuthenticatedUser) {
    const session = await this.db.chatSession.findFirst({
      where: { id: sessionId },
      select: { id: true, status: true, ticketId: true },
    });
    if (!session) {
      throw AppError.notFound('chat session');
    }
    if (session.status === 'ENDED') {
      throw AppError.validation('This chat has already ended');
    }

    if (session.ticketId) {
      await this.tickets.assign(session.ticketId, actor, { assignedAgentId: actor.id });
    }
    const updated = await this.db.chatSession.update({
      where: { id: sessionId },
      data: { status: 'ACTIVE' },
      select: SESSION_SELECT,
    });

    await this.publish(actor.organizationId, sessionId, CHAT_EVENTS.ACCEPTED, {
      sessionId,
      agent: `${actor.firstName} ${actor.lastName}`.trim(),
    });
    return updated;
  }

  private async resolveContact(organizationId: string, input: StartChatInput) {
    if (!input.email) {
      return null;
    }
    const existing = await this.db.contact.findFirst({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }
    const [firstName, ...rest] = (input.name ?? input.email).trim().split(/\s+/);
    const contact = await this.db.contact.create({
      data: {
        organizationId,
        firstName: firstName || input.email,
        lastName: rest.join(' ') || null,
        email: input.email,
      },
      select: { id: true },
    });
    return contact.id;
  }

  /**
   * Chat events travel over Redis rather than a direct gateway call, so they reach the
   * visitor's socket whichever API instance is holding it.
   */
  private async publish(
    organizationId: string,
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.redis.publish(
      CHAT_BRIDGE_CHANNEL,
      JSON.stringify({ organizationId, room: chatRoom(sessionId), event, payload }),
    );
  }
}
