import type { Job } from 'bullmq';
import type { PrismaClient } from '@digisoft/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AccessGate } from '../access-gate';

export const RT_BRIDGE_CHANNEL = 'rt:emit';

export interface DeliverNotificationJob {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  data?: Record<string, unknown>;
  /** Stable key so a retried job does not create a second notification row. */
  dedupeKey?: string;
}

/**
 * Class A (requires active access): a notification about the organization's tickets is a
 * business effect. Skipped - logged, not retried - when access ended.
 */
export async function handleDeliverNotification(
  job: Job<DeliverNotificationJob>,
  deps: { prisma: PrismaClient; redis: Redis; logger: Logger; gate: AccessGate },
): Promise<{ notificationId: string | null }> {
  const { organizationId, userId, type, title, body, link, data, dedupeKey } = job.data;

  if (!(await deps.gate.allows(organizationId, 'notification', { jobId: job.id, type }))) {
    return { notificationId: null };
  }

  if (dedupeKey) {
    const existing = await deps.prisma.notification.findFirst({
      where: { organizationId, userId, type, data: { path: ['dedupeKey'], equals: dedupeKey } },
      select: { id: true },
    });
    if (existing) {
      deps.logger.debug({ jobId: job.id }, 'Notification already delivered; skipping');
      return { notificationId: existing.id };
    }
  }

  const notification = await deps.prisma.notification.create({
    data: {
      organizationId,
      userId,
      type,
      title,
      body: body ?? null,
      link: link ?? null,
      data: { ...(data ?? {}), ...(dedupeKey ? { dedupeKey } : {}) },
    },
  });

  // The API instances hold the sockets; they fan this out to the right rooms.
  await deps.redis.publish(
    RT_BRIDGE_CHANNEL,
    JSON.stringify({
      organizationId,
      userId,
      event: 'notification.created',
      payload: notification,
    }),
  );

  return { notificationId: notification.id };
}
