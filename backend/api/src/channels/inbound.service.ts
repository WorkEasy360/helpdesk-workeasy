import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Prisma, TenantPrismaClient, TicketSource } from '@digisoft/db';
import { safeFetch, ticketNumberFromSubject, type InboundMessage } from '@digisoft/channels';
import type { ChannelType } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { TicketsService } from '../tickets/tickets.service';
import { TicketMessagesService } from '../tickets/ticket-messages.service';
import { STORAGE_PROVIDER, type StorageProvider } from '@digisoft/storage';
import { AppConfig } from '../config/config.module';

const ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;

/** Channel type → the ticket source recorded on the ticket and its messages. */
const SOURCE_BY_TYPE: Record<ChannelType, TicketSource> = {
  EMAIL: 'EMAIL',
  CHAT: 'CHAT',
  WHATSAPP: 'WHATSAPP',
  INSTAGRAM: 'INSTAGRAM',
  FACEBOOK: 'FACEBOOK',
  TELEGRAM: 'TELEGRAM',
  VOICE: 'PHONE',
};

/** How long a messaging conversation keeps landing on the same open ticket. */
const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IngestChannel {
  id: string;
  organizationId: string;
  type: ChannelType;
  provider: string;
  identifier: string | null;
  config: Prisma.JsonValue;
  departmentId: string | null;
  priorityId: string | null;
  categoryId: string | null;
}

export type IngestOutcome =
  | { status: 'PROCESSED'; ticketId: string; messageId: string | null }
  | { status: 'IGNORED'; reason: string }
  | { status: 'DUPLICATE' };

/**
 * Turns a parsed inbound message into help desk records. Everything a channel needs to
 * agree on lives here — identity, threading, attachments, dedupe — so an adapter only
 * has to speak its provider's protocol.
 *
 * Runs inside the tenant scope its caller opened.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly tickets: TicketsService,
    private readonly messages: TicketMessagesService,
    private readonly config: AppConfig,
  ) {}

  async ingest(channel: IngestChannel, message: InboundMessage): Promise<IngestOutcome> {
    // The unique (channelId, externalId) index is what makes redelivery harmless: the
    // second attempt loses the race to insert and stops here.
    let eventId: string;
    try {
      const event = await this.db.channelEvent.create({
        data: {
          organizationId: channel.organizationId,
          channelId: channel.id,
          externalId: message.externalId,
          payload: (message.meta ?? {}) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      eventId = event.id;
    } catch {
      return { status: 'DUPLICATE' };
    }

    try {
      const outcome = await this.process(channel, message);
      await this.db.channelEvent.update({
        where: { id: eventId },
        data: {
          status: outcome.status === 'PROCESSED' ? 'PROCESSED' : 'IGNORED',
          ticketId: outcome.status === 'PROCESSED' ? outcome.ticketId : null,
          messageId: outcome.status === 'PROCESSED' ? outcome.messageId : null,
          error: outcome.status === 'IGNORED' ? outcome.reason : null,
          processedAt: new Date(),
        },
      });
      await this.db.channel.update({
        where: { id: channel.id },
        data: { lastInboundAt: new Date() },
      });
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown ingestion failure';
      this.logger.error(`Channel ${channel.id} ingestion failed: ${reason}`);
      await this.db.channelEvent.update({
        where: { id: eventId },
        data: { status: 'FAILED', error: reason, processedAt: new Date() },
      });
      await this.db.channel.update({
        where: { id: channel.id },
        data: { lastErrorAt: new Date(), lastError: reason.slice(0, 500) },
      });
      throw error;
    }
  }

  private async process(channel: IngestChannel, message: InboundMessage): Promise<IngestOutcome> {
    if (message.isAutomated) {
      // Answering an auto-responder is how two machines end up talking forever.
      return { status: 'IGNORED', reason: 'Automated message (auto-reply, bounce or list mail)' };
    }
    if (!message.text.trim()) {
      return { status: 'IGNORED', reason: 'Message carried no text' };
    }

    const contactId = await this.resolveContact(channel, message);

    if (message.meta?.['kind'] === 'call') {
      return this.recordCall(channel, message, contactId);
    }

    const source = SOURCE_BY_TYPE[channel.type];
    const existing = await this.findThread(channel, message, contactId);

    if (existing) {
      const stored = await this.messages.addInboundMessage({
        organizationId: channel.organizationId,
        ticketId: existing,
        contactId,
        bodyText: message.text,
        bodyHtml: message.html ?? null,
        channel: source,
        externalMessageId: message.externalId,
      });
      await this.attach(channel, message, existing, stored.id);
      return { status: 'PROCESSED', ticketId: existing, messageId: stored.id };
    }

    const ticket = await this.tickets.createTicket({
      organizationId: channel.organizationId,
      subject: this.subjectFor(message),
      description: message.text,
      source,
      channelId: channel.id,
      contactId,
      departmentId: channel.departmentId,
      priorityId: channel.priorityId,
      categoryId: channel.categoryId,
    });

    // The first message is the ticket description; store it as a message too so the
    // conversation reads the same on every channel and threading has something to match.
    const stored = await this.db.ticketMessage.create({
      data: {
        organizationId: channel.organizationId,
        ticketId: ticket.id,
        type: 'PUBLIC_REPLY',
        direction: 'INBOUND',
        authorContactId: contactId,
        bodyText: message.text,
        bodyHtml: message.html ?? null,
        channel: source,
        externalMessageId: message.externalId,
      },
      select: { id: true },
    });
    await this.attach(channel, message, ticket.id, stored.id);

    return { status: 'PROCESSED', ticketId: ticket.id, messageId: stored.id };
  }

  /** A call is logged as a call, with its recording — not as a chat message. */
  private async recordCall(
    channel: IngestChannel,
    message: InboundMessage,
    contactId: string,
  ): Promise<IngestOutcome> {
    const meta = message.meta ?? {};
    const direction = meta['direction'] === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND';
    const durationSeconds = typeof meta['durationSeconds'] === 'number' ? meta['durationSeconds'] : null;
    const recordingUrl = typeof meta['recordingUrl'] === 'string' ? meta['recordingUrl'] : null;

    const existing = await this.db.activity.findFirst({
      where: { externalCallId: message.externalId },
      select: { id: true, ticketId: true },
    });

    if (existing) {
      // Twilio posts several times per call; later posts complete the same record.
      await this.db.activity.update({
        where: { id: existing.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          ...(durationSeconds !== null ? { callDurationSeconds: durationSeconds } : {}),
          ...(recordingUrl ? { recordingUrl } : {}),
          callOutcome: String(meta['status'] ?? 'completed'),
          description: message.text,
        },
      });
      return { status: 'PROCESSED', ticketId: existing.ticketId ?? '', messageId: null };
    }

    const ticket = await this.tickets.createTicket({
      organizationId: channel.organizationId,
      subject: `${direction === 'INBOUND' ? 'Inbound' : 'Outbound'} call from ${message.from.phone ?? message.from.externalId}`,
      description: message.text,
      source: 'PHONE',
      channelId: channel.id,
      contactId,
      departmentId: channel.departmentId,
      priorityId: channel.priorityId,
      categoryId: channel.categoryId,
    });

    await this.db.activity.create({
      data: {
        organizationId: channel.organizationId,
        type: 'CALL',
        status: 'COMPLETED',
        completedAt: new Date(),
        subject: `Call with ${message.from.phone ?? message.from.externalId}`,
        description: message.text,
        callDirection: direction,
        callDurationSeconds: durationSeconds,
        callOutcome: String(meta['status'] ?? 'completed'),
        externalCallId: message.externalId,
        recordingUrl,
        ticketId: ticket.id,
        contactId,
      },
    });

    return { status: 'PROCESSED', ticketId: ticket.id, messageId: null };
  }

  /**
   * The contact behind a channel identity, created the first time we hear from them.
   * An email address that already belongs to a contact is reused, so the same person
   * writing from the portal and from their mailbox stays one contact.
   */
  private async resolveContact(channel: IngestChannel, message: InboundMessage): Promise<string> {
    const externalId = message.from.externalId.toLowerCase();

    const identity = await this.db.channelIdentity.findFirst({
      where: { type: channel.type, externalId },
      select: { contactId: true },
    });
    if (identity) {
      return identity.contactId;
    }

    const email = message.from.email?.toLowerCase();
    const byEmail = email
      ? await this.db.contact.findFirst({ where: { email }, select: { id: true } })
      : null;

    const [firstName, ...rest] = (message.from.name ?? email ?? externalId).trim().split(/\s+/);
    const contactId =
      byEmail?.id ??
      (
        await this.db.contact.create({
          data: {
            organizationId: channel.organizationId,
            firstName: firstName || externalId,
            lastName: rest.join(' ') || null,
            email: email ?? null,
            phone: message.from.phone ?? null,
          },
          select: { id: true },
        })
      ).id;

    await this.db.channelIdentity.create({
      data: {
        organizationId: channel.organizationId,
        channelId: channel.id,
        type: channel.type,
        externalId,
        displayName: message.from.name ?? null,
        contactId,
      },
    });

    return contactId;
  }

  /**
   * Which ticket this message belongs to, in order of how sure we can be:
   * the message it replies to, then the ticket number a mail client carried back in the
   * subject, then — for conversational channels — the contact's own open ticket from the
   * last day. Anything else starts a new ticket.
   */
  private async findThread(
    channel: IngestChannel,
    message: InboundMessage,
    contactId: string,
  ): Promise<string | null> {
    const references = [message.inReplyTo, ...(message.references ?? [])].filter(
      (value): value is string => Boolean(value),
    );

    if (references.length > 0) {
      const parent = await this.db.ticketMessage.findFirst({
        where: { externalMessageId: { in: references } },
        select: { ticketId: true },
        orderBy: { createdAt: 'desc' },
      });
      if (parent) {
        return parent.ticketId;
      }
    }

    const ticketNumber = ticketNumberFromSubject(message.subject);
    if (ticketNumber !== null) {
      const referenced = await this.db.ticket.findFirst({
        where: { ticketNumber, contactId },
        select: { id: true },
      });
      if (referenced) {
        return referenced.id;
      }
    }

    if (channel.type === 'EMAIL' || channel.type === 'VOICE') {
      // Email without a reference is a new conversation, whatever its subject says.
      return null;
    }

    const recent = await this.db.ticket.findFirst({
      where: {
        contactId,
        channelId: channel.id,
        status: { isResolved: false, isClosed: false },
        updatedAt: { gte: new Date(Date.now() - CONVERSATION_WINDOW_MS) },
      },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    });
    return recent?.id ?? null;
  }

  private subjectFor(message: InboundMessage): string {
    const subject = message.subject?.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
    if (subject) {
      return subject.slice(0, 200);
    }
    const firstLine = message.text.split('\n')[0]?.trim() ?? '';
    return (firstLine.length > 0 ? firstLine : 'New conversation').slice(0, 120);
  }

  /** Stores inbound files through the same storage provider as agent uploads. */
  private async attach(
    channel: IngestChannel,
    message: InboundMessage,
    ticketId: string,
    messageId: string,
  ): Promise<void> {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) {
      return;
    }
    const maxBytes = this.config.get('ATTACHMENT_MAX_BYTES');

    for (const attachment of attachments) {
      try {
        const buffer = attachment.contentBase64
          ? Buffer.from(attachment.contentBase64, 'base64')
          : await this.fetchAttachment(attachment.url, maxBytes);
        if (!buffer || buffer.length === 0 || buffer.length > maxBytes) {
          this.logger.warn(
            `Skipped inbound attachment ${attachment.fileName}: ${buffer ? 'too large' : 'could not be fetched'}`,
          );
          continue;
        }

        const safeName = attachment.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
        const storageKey = `${channel.organizationId}/tickets/${ticketId}/${randomUUID()}${path
          .extname(safeName)
          .toLowerCase()}`;
        await this.storage.put(storageKey, buffer, attachment.mimeType);

        await this.db.attachment.create({
          data: {
            organizationId: channel.organizationId,
            ticketId,
            messageId,
            fileName: safeName,
            fileSize: buffer.length,
            mimeType: attachment.mimeType,
            storageKey,
          },
        });
      } catch (error) {
        // A failed attachment must never cost us the message it came with.
        this.logger.warn(
          `Could not store inbound attachment ${attachment.fileName}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  /**
   * The URL comes from the webhook payload, so it is fetched through the SSRF guard:
   * public addresses only, redirects re-checked, and the body capped while it streams.
   */
  private async fetchAttachment(url: string | undefined, maxBytes: number): Promise<Buffer | null> {
    if (!url) {
      return null;
    }
    const response = await safeFetch(url, { maxBytes, timeoutMs: ATTACHMENT_FETCH_TIMEOUT_MS });
    if (!response.ok) {
      return null;
    }
    return response.body;
  }
}
