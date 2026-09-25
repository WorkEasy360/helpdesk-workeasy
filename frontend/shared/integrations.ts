import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, patchSchema } from './field';
import { isPublicHttpUrl } from './network';

/**
 * Events an outbound webhook can subscribe to. The names match the audit actions, so
 * one vocabulary covers the audit trail, automation and integrations.
 */
export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.assigned',
  'ticket.status_changed',
  'ticket.replied',
  'ticket.customer_replied',
  'ticket.resolved',
  'ticket.closed',
  'contact.created',
  'chat.started',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const webhookEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z
    .string()
    .url()
    .max(500)
    .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
      message: 'Use an http(s) URL',
    })
    // Obvious internal targets are refused here; the delivery worker re-checks the
    // resolved address on every attempt, which is the check that actually matters.
    .refine((value) => isPublicHttpUrl(value), {
      message: 'Webhook URLs must point at a public host',
    }),
  /** Empty means every event. */
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).default([]),
  isActive: z.boolean().default(true),
});
export type WebhookEndpointInput = z.infer<typeof webhookEndpointSchema>;
export type WebhookEndpointFormValues = z.input<typeof webhookEndpointSchema>;

export const updateWebhookEndpointSchema = patchSchema(webhookEndpointSchema);
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export const listWebhookDeliveriesQuerySchema = paginationQuerySchema.extend({
  endpointId: z.string().min(1).optional(),
  status: z.enum(['PENDING', 'DELIVERED', 'FAILED']).optional(),
  event: z.enum(WEBHOOK_EVENTS).optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

export const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  roleId: z.string().min(1),
  expiresAt: optionalField(z.coerce.date()),
});
export type ApiKeyInput = z.infer<typeof apiKeySchema>;
export type ApiKeyFormValues = z.input<typeof apiKeySchema>;
