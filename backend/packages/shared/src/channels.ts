import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';

export const CHANNEL_TYPES = [
  'EMAIL',
  'CHAT',
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'TELEGRAM',
  'VOICE',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/**
 * Adapters available for each channel type. The key is stored on the channel and picks
 * the provider implementation; anything not listed here is refused at the API edge.
 */
export const CHANNEL_PROVIDERS = {
  EMAIL: ['generic', 'mailgun', 'postmark'],
  CHAT: ['native'],
  WHATSAPP: ['whatsapp_cloud'],
  INSTAGRAM: ['meta'],
  FACEBOOK: ['meta'],
  TELEGRAM: ['telegram'],
  VOICE: ['twilio'],
} as const satisfies Record<ChannelType, readonly string[]>;

export type ChannelProviderKey = (typeof CHANNEL_PROVIDERS)[ChannelType][number];

/** Credentials each provider needs. They are write-only: the API never returns them. */
export const CHANNEL_SECRET_FIELDS: Record<string, { key: string; label: string; required: boolean }[]> = {
  generic: [{ key: 'signingSecret', label: 'Shared signing secret', required: false }],
  mailgun: [
    { key: 'signingKey', label: 'Webhook signing key', required: true },
    { key: 'apiKey', label: 'API key (sending)', required: false },
    { key: 'domain', label: 'Sending domain', required: false },
  ],
  postmark: [
    { key: 'serverToken', label: 'Server token', required: false },
    { key: 'webhookUsername', label: 'Inbound basic-auth user', required: false },
    { key: 'webhookPassword', label: 'Inbound basic-auth password', required: false },
  ],
  native: [],
  whatsapp_cloud: [
    { key: 'accessToken', label: 'Access token', required: true },
    { key: 'phoneNumberId', label: 'Phone number id', required: true },
    { key: 'appSecret', label: 'App secret', required: true },
    { key: 'verifyToken', label: 'Verify token', required: true },
  ],
  meta: [
    { key: 'pageAccessToken', label: 'Page access token', required: true },
    { key: 'appSecret', label: 'App secret', required: true },
    { key: 'verifyToken', label: 'Verify token', required: true },
  ],
  telegram: [
    { key: 'botToken', label: 'Bot token', required: true },
    { key: 'secretToken', label: 'Webhook secret token', required: false },
  ],
  twilio: [
    { key: 'accountSid', label: 'Account SID', required: true },
    { key: 'authToken', label: 'Auth token', required: true },
  ],
};

export const emailChannelConfigSchema = z.object({
  fromName: optionalField(z.string().trim().max(120)),
  replyTo: optionalField(z.string().email().toLowerCase().trim()),
  /// Appended to every outbound reply.
  signature: optionalField(z.string().trim().max(2000)),
  /// Cut the quoted history off inbound replies before storing them.
  stripQuotedText: z.boolean().default(true),
});

export const chatChannelConfigSchema = z.object({
  greeting: z.string().trim().max(300).default('Hi! How can we help?'),
  offlineMessage: z
    .string()
    .trim()
    .max(300)
    .default('We are offline right now — leave a message and we will reply by email.'),
  requireEmail: z.boolean().default(true),
  /// Origins allowed to embed the widget; empty means any.
  allowedOrigins: z.array(z.string().trim().max(200)).max(20).default([]),
});

export const channelConfigSchema = z.record(z.string(), z.unknown());

export const channelSchema = z.object({
  type: z.enum(CHANNEL_TYPES),
  provider: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  identifier: optionalField(z.string().trim().max(200)),
  isActive: z.boolean().default(true),
  config: channelConfigSchema.default({}),
  /** Write-only. Keys listed in `CHANNEL_SECRET_FIELDS`; an omitted key keeps its value. */
  secrets: z.record(z.string(), z.string().max(4000)).optional(),
  departmentId: optionalField(z.string().min(1)),
  priorityId: optionalField(z.string().min(1)),
  categoryId: optionalField(z.string().min(1)),
});
export type ChannelInput = z.infer<typeof channelSchema>;
export type ChannelFormValues = z.input<typeof channelSchema>;

export const updateChannelSchema = patchSchema(channelSchema).omit({ type: true });
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const listChannelsQuerySchema = z.object({
  type: z.enum(CHANNEL_TYPES).optional(),
  isActive: queryBoolean.optional(),
});
export type ListChannelsQuery = z.infer<typeof listChannelsQuerySchema>;

export const listChannelEventsQuerySchema = paginationQuerySchema.extend({
  channelId: z.string().min(1).optional(),
  status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional(),
});
export type ListChannelEventsQuery = z.infer<typeof listChannelEventsQuerySchema>;

/** Returns the provider keys valid for a channel type. */
export function providersFor(type: ChannelType): readonly string[] {
  return CHANNEL_PROVIDERS[type];
}
