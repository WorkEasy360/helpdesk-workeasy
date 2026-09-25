import { createHmac, randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import { safeFetch, UnsafeUrlError } from '@digisoft/channels';
import type { Logger } from 'pino';
import type { PrismaClient } from '@digisoft/db';

export interface WebhookDeliveryJob {
  organizationId: string;
  deliveryId: string;
}

const TIMEOUT_MS = 10_000;
const BODY_SNIPPET = 2000;

/**
 * Hands one event to a customer's endpoint and records what happened.
 *
 * The body is signed with the endpoint's own key over `timestamp.payload`, so a
 * receiver can both authenticate the call and refuse a replayed one. Retries are
 * BullMQ's, with the delivery row carrying the attempt count for the UI; after the
 * budget is spent the delivery is marked FAILED rather than retried forever.
 */
export async function handleWebhookDelivery(
  job: Job<WebhookDeliveryJob>,
  deps: { prisma: PrismaClient; logger: Logger; maxAttempts: number },
): Promise<{ delivered: boolean; status: number | null }> {
  const delivery = await deps.prisma.webhookDelivery.findFirst({
    where: { id: job.data.deliveryId, organizationId: job.data.organizationId },
    select: {
      id: true,
      event: true,
      payload: true,
      attempts: true,
      endpoint: { select: { id: true, url: true, secret: true, isActive: true } },
    },
  });

  if (!delivery || !delivery.endpoint.isActive) {
    return { delivered: false, status: null };
  }

  const attempt = delivery.attempts + 1;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    createdAt: new Date().toISOString(),
    data: delivery.payload,
  });
  const signature = createHmac('sha256', delivery.endpoint.secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  try {
    // The endpoint URL is customer-supplied: the guard resolves it and refuses internal
    // addresses on every attempt, since DNS can change between creation and delivery.
    const response = await safeFetch(delivery.endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Digisoft360-Helpdesk-Webhooks/1',
        'X-Digisoft-Event': delivery.event,
        'X-Digisoft-Delivery': delivery.id,
        'X-Digisoft-Timestamp': timestamp,
        'X-Digisoft-Signature': `t=${timestamp},v1=${signature}`,
        'Idempotency-Key': `${delivery.id}-${randomUUID()}`,
      },
      body,
      timeoutMs: TIMEOUT_MS,
      // Only a snippet is kept, so a huge response is cut rather than buffered.
      maxBytes: BODY_SNIPPET * 4,
      onOverflow: 'truncate',
    });

    const responseBody = response.body.toString('utf8').slice(0, BODY_SNIPPET);
    const delivered = response.ok;

    await deps.prisma.$transaction([
      deps.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: attempt,
          status: delivered ? 'DELIVERED' : attempt >= deps.maxAttempts ? 'FAILED' : 'PENDING',
          responseStatus: response.status,
          responseBody,
          error: delivered ? null : `HTTP ${response.status}`,
          deliveredAt: delivered ? new Date() : null,
        },
      }),
      deps.prisma.webhookEndpoint.update({
        where: { id: delivery.endpoint.id },
        data: delivered
          ? { lastSuccessAt: new Date(), failureCount: 0 }
          : { lastFailureAt: new Date(), failureCount: { increment: 1 } },
      }),
    ]);

    if (!delivered) {
      throw new Error(`Endpoint answered HTTP ${response.status}`);
    }
    return { delivered: true, status: response.status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Delivery failed';
    // A refused target will be refused again; retrying only delays the verdict.
    const unsafe = error instanceof UnsafeUrlError;
    await deps.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        status: unsafe || attempt >= deps.maxAttempts ? 'FAILED' : 'PENDING',
        error: reason.slice(0, 500),
      },
    });
    deps.logger.warn(
      { deliveryId: delivery.id, attempt, event: delivery.event },
      `Webhook delivery failed: ${reason}`,
    );
    throw unsafe ? new UnrecoverableError(reason) : error;
  }
}
