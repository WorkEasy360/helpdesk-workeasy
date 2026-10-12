import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { PrismaClient } from '@digisoft/db';
import { decryptSecrets, providerFor, readEncryptionKey } from '@digisoft/channels';
import type { ChannelType } from '@digisoft/shared';
import type { OutboundEmail } from '../email-provider';
import type { AccessGate } from '../access-gate';

export interface ChannelSendJob {
  organizationId: string;
  channelId: string;
  ticketId: string;
  messageId: string;
  to: string;
}

interface Deps {
  prisma: PrismaClient;
  logger: Logger;
  sendEmail: (message: OutboundEmail) => Promise<string | null>;
  encryptionKey?: string;
  gate: AccessGate;
}

/**
 * Delivers an agent's reply back out over the channel the ticket arrived on.
 *
 * Email goes through the deployment's own mail provider with the threading headers a
 * mail client needs, so the customer's answer lands back on the same ticket. Messaging
 * channels go through their adapter. Either way the provider's message id is written
 * back onto the stored message, which is what makes the next inbound reply thread.
 *
 * Class A (requires active access): an outbound message to a customer is a business effect.
 * Checked right before it, and skipped - logged, not retried - when access ended.
 */
export async function handleChannelSend(
  job: Job<ChannelSendJob>,
  deps: Deps,
): Promise<{ delivered: boolean; externalId: string | null }> {
  const { organizationId, channelId, ticketId, messageId, to } = job.data;

  if (!(await deps.gate.allows(organizationId, 'channel-send', { jobId: job.id, channelId, ticketId }))) {
    return { delivered: false, externalId: null };
  }

  const [channel, message, ticket] = await Promise.all([
    deps.prisma.channel.findFirst({
      where: { id: channelId, organizationId },
      select: {
        id: true,
        type: true,
        provider: true,
        identifier: true,
        config: true,
        secrets: true,
        isActive: true,
      },
    }),
    deps.prisma.ticketMessage.findFirst({
      where: { id: messageId, organizationId },
      select: { id: true, bodyText: true, bodyHtml: true, externalMessageId: true },
    }),
    deps.prisma.ticket.findFirst({
      where: { id: ticketId, organizationId },
      select: { id: true, ticketNumber: true, subject: true },
    }),
  ]);

  if (!channel?.isActive || !message || !ticket) {
    deps.logger.warn({ jobId: job.id, channelId, messageId }, 'Channel reply is no longer deliverable');
    return { delivered: false, externalId: null };
  }
  if (message.externalMessageId) {
    // A retry after a successful send: the id is already stored, so stop here.
    return { delivered: true, externalId: message.externalMessageId };
  }

  const config = (channel.config ?? {}) as Record<string, unknown>;
  let externalId: string | null = null;

  try {
    if (channel.type === 'EMAIL') {
      externalId = await sendEmailReply({ channel, config, message, ticket, to, deps });
    } else {
      const provider = providerFor(channel.type as ChannelType, channel.provider);
      if (!provider?.send) {
        deps.logger.warn({ channelId, type: channel.type }, 'Channel cannot send; reply not delivered');
        return { delivered: false, externalId: null };
      }
      const secrets = decryptSecrets(channel.secrets, readEncryptionKey(deps.encryptionKey));
      const result = await provider.send({ to, text: message.bodyText }, secrets, config);
      externalId = result.externalId;
    }
  } catch (error) {
    // The failure belongs on the channel, where an administrator will look for it.
    const reason = error instanceof Error ? error.message : 'Delivery failed';
    await deps.prisma.channel.update({
      where: { id: channel.id },
      data: { lastErrorAt: new Date(), lastError: reason.slice(0, 500) },
    });
    throw error;
  }

  await deps.prisma.$transaction([
    deps.prisma.ticketMessage.update({
      where: { id: message.id },
      data: { externalMessageId: externalId, channel: sourceFor(channel.type as ChannelType) },
    }),
    deps.prisma.channel.update({
      where: { id: channel.id },
      data: { lastOutboundAt: new Date(), lastError: null, lastErrorAt: null },
    }),
  ]);

  deps.logger.info(
    { jobId: job.id, channel: channel.type, ticket: ticket.ticketNumber, externalId },
    'Channel reply delivered',
  );
  return { delivered: true, externalId };
}

async function sendEmailReply(input: {
  channel: { identifier: string | null };
  config: Record<string, unknown>;
  message: { bodyText: string; bodyHtml: string | null };
  ticket: { id: string; ticketNumber: number; subject: string };
  to: string;
  deps: Deps;
}): Promise<string | null> {
  const { channel, config, message, ticket, to, deps } = input;

  // The last inbound message is what this reply answers; its id threads the two.
  const lastInbound = await deps.prisma.ticketMessage.findFirst({
    where: { ticketId: ticket.id, direction: 'INBOUND', externalMessageId: { not: null } },
    select: { externalMessageId: true },
    orderBy: { createdAt: 'desc' },
  });

  const domain = channel.identifier?.split('@')[1] ?? 'digisoft360.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const signature = typeof config['signature'] === 'string' ? config['signature'] : null;
  const text = signature ? `${message.bodyText}\n\n--\n${signature}` : message.bodyText;

  const headers: Record<string, string> = { 'Message-ID': messageId };
  if (lastInbound?.externalMessageId) {
    headers['In-Reply-To'] = lastInbound.externalMessageId;
    headers['References'] = lastInbound.externalMessageId;
  }

  const fromName = typeof config['fromName'] === 'string' ? config['fromName'] : null;
  const from =
    channel.identifier && fromName
      ? `${fromName} <${channel.identifier}>`
      : (channel.identifier ?? undefined);
  const replyTo = typeof config['replyTo'] === 'string' ? config['replyTo'] : channel.identifier;

  await deps.sendEmail({
    to,
    // The ticket number in the subject is the fallback when a client drops References.
    subject: `Re: [#${ticket.ticketNumber}] ${ticket.subject}`,
    text,
    html: message.bodyHtml ?? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
    from,
    replyTo: replyTo ?? undefined,
    headers,
  });

  return messageId;
}

function sourceFor(type: ChannelType) {
  return type === 'VOICE' ? ('PHONE' as const) : (type as Exclude<ChannelType, 'VOICE'>);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
