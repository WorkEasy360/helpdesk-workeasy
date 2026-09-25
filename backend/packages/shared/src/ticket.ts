import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean } from './field';

export const TICKET_SOURCES = [
  'AGENT',
  'PORTAL',
  'WEB_FORM',
  'EMAIL',
  'CHAT',
  'PHONE',
  'API',
  'WHATSAPP',
  'INSTAGRAM',
  'FACEBOOK',
  'TELEGRAM',
] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const MESSAGE_TYPES = ['PUBLIC_REPLY', 'INTERNAL_COMMENT', 'SYSTEM_NOTE'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const TICKET_LINK_TYPES = ['RELATED', 'DUPLICATE', 'BLOCKS'] as const;
export type TicketLinkType = (typeof TICKET_LINK_TYPES)[number];

/** Status buckets derived from the `isResolved` / `isClosed` flags. */
export const TICKET_STATUS_CATEGORIES = ['open', 'resolved', 'closed'] as const;
export type TicketStatusCategory = (typeof TICKET_STATUS_CATEGORIES)[number];

/** A date (`2026-01-31`) or a full ISO 8601 timestamp, as a query-string parameter. */
const queryDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1).max(50_000),
  contactId: optionalField(z.string().min(1)),
  accountId: optionalField(z.string().min(1)),
  departmentId: optionalField(z.string().min(1)),
  assignedAgentId: optionalField(z.string().min(1)),
  categoryId: optionalField(z.string().min(1)),
  statusId: optionalField(z.string().min(1)),
  priorityId: optionalField(z.string().min(1)),
  source: z.enum(TICKET_SOURCES).default('AGENT'),
  tagIds: z.array(z.string().min(1)).max(50).default([]),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type TicketFormValues = z.input<typeof createTicketSchema>;

export const updateTicketSchema = z.object({
  subject: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().min(1).max(50_000).optional(),
  contactId: optionalField(z.string().min(1)),
  accountId: optionalField(z.string().min(1)),
  departmentId: optionalField(z.string().min(1)),
  categoryId: optionalField(z.string().min(1)),
  customFields: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const assignTicketSchema = z
  .object({
    assignedAgentId: optionalField(z.string().min(1)),
    departmentId: optionalField(z.string().min(1)),
  })
  .refine(
    (value) => value.assignedAgentId !== undefined || value.departmentId !== undefined,
    'Provide an agent, a department, or both',
  );
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

export const changeStatusSchema = z.object({
  statusId: z.string().min(1),
  /** Required by the API when moving to a status that resolves the ticket. */
  resolutionNote: optionalField(z.string().trim().max(5_000)),
});
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export const changePrioritySchema = z.object({ priorityId: z.string().min(1) });
export type ChangePriorityInput = z.infer<typeof changePrioritySchema>;

export const resolveTicketSchema = z.object({
  resolutionNote: z.string().trim().min(1, 'A resolution note is required').max(5_000),
});
export type ResolveTicketInput = z.infer<typeof resolveTicketSchema>;

export const setTicketTagsSchema = z.object({ tagIds: z.array(z.string().min(1)).max(50) });
export type SetTicketTagsInput = z.infer<typeof setTicketTagsSchema>;

export const mergeTicketSchema = z.object({
  /** The ticket that survives; the one being acted on is closed and points at it. */
  targetTicketId: z.string().min(1),
  comment: optionalField(z.string().trim().max(2_000)),
});
export type MergeTicketInput = z.infer<typeof mergeTicketSchema>;

export const linkTicketSchema = z.object({
  linkedTicketId: z.string().min(1),
  type: z.enum(TICKET_LINK_TYPES).default('RELATED'),
});
export type LinkTicketInput = z.infer<typeof linkTicketSchema>;

export const createMessageSchema = z.object({
  bodyText: z.string().trim().min(1).max(50_000),
  bodyHtml: optionalField(z.string().max(200_000)),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type MessageFormValues = z.input<typeof createMessageSchema>;

export const listTicketsQuerySchema = paginationQuerySchema.extend({
  statusId: z.string().min(1).optional(),
  priorityId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  assignedAgentId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  tagId: z.string().min(1).optional(),
  source: z.enum(TICKET_SOURCES).optional(),
  /** Convenience filters the agent workspace uses for its saved views. */
  assignedToMe: queryBoolean.optional(),
  unassigned: queryBoolean.optional(),
  open: queryBoolean.optional(),
  /**
   * Creation window. A bare date (`2026-01-31`) covers that whole UTC day, so
   * `createdFrom=2026-01-01&createdTo=2026-01-31` is all of January.
   */
  createdFrom: queryDate.optional(),
  createdTo: queryDate.optional(),
  /** Still-open tickets whose resolution due time (`dueAt`) has passed. */
  overdue: queryBoolean.optional(),
  /** Matches by the status flags, so it follows an organization's own statuses. */
  statusCategory: z.enum(TICKET_STATUS_CATEGORIES).optional(),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const BULK_TICKET_ACTIONS = [
  'assign',
  'unassign',
  'status',
  'resolve',
  'close',
  'reopen',
  'priority',
  'addTags',
  'removeTags',
] as const;
export type BulkTicketAction = (typeof BULK_TICKET_ACTIONS)[number];

/** How many tickets one bulk request may touch. */
export const BULK_TICKET_LIMIT = 100;

const bulkTicketIds = z.array(z.string().min(1)).min(1).max(BULK_TICKET_LIMIT);
const noPayload = z.object({}).optional();
const tagIdsPayload = z.object({ tagIds: z.array(z.string().min(1)).min(1).max(50) });

/**
 * One action applied to many tickets. Each ticket runs through the same code path as
 * its single-ticket endpoint, so a ticket the caller cannot see, a blueprint that
 * refuses the move or a missing resolution note fails that ticket alone.
 */
export const bulkUpdateTicketsSchema = z.discriminatedUnion('action', [
  z.object({ ticketIds: bulkTicketIds, action: z.literal('assign'), payload: assignTicketSchema }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('unassign'), payload: noPayload }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('status'), payload: changeStatusSchema }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('resolve'), payload: resolveTicketSchema }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('close'), payload: noPayload }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('reopen'), payload: noPayload }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('priority'), payload: changePrioritySchema }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('addTags'), payload: tagIdsPayload }),
  z.object({ ticketIds: bulkTicketIds, action: z.literal('removeTags'), payload: tagIdsPayload }),
]);
export type BulkUpdateTicketsInput = z.infer<typeof bulkUpdateTicketsSchema>;

export interface BulkTicketResult {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export interface BulkUpdateTicketsResponse {
  action: BulkTicketAction;
  succeeded: number;
  failed: number;
  results: BulkTicketResult[];
}

export const ticketStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #2563eb')
    .default('#64748b'),
  position: z.number().int().min(0).max(999).default(0),
  isDefault: z.boolean().default(false),
  isResolved: z.boolean().default(false),
  isClosed: z.boolean().default(false),
  /** Stops the SLA clock while the ticket waits on someone else. */
  pausesSla: z.boolean().default(false),
});
export type TicketStatusInput = z.infer<typeof ticketStatusSchema>;

export const ticketPrioritySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #2563eb')
    .default('#64748b'),
  weight: z.number().int().min(0).max(1000).default(0),
  position: z.number().int().min(0).max(999).default(0),
  isDefault: z.boolean().default(false),
});
export type TicketPriorityInput = z.infer<typeof ticketPrioritySchema>;

export const ticketCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalField(z.string().trim().max(500)),
  parentId: optionalField(z.string().min(1)),
});
export type TicketCategoryInput = z.infer<typeof ticketCategorySchema>;

export const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #2563eb')
    .default('#64748b'),
});
export type TagInput = z.infer<typeof tagSchema>;

/**
 * `GET …/attachments/:id/download?mode=url` (or `Accept: application/json`). With
 * object storage `url` is a pre-signed link anyone holding it can open until
 * `expiresAt` (`direct: true`). With local storage there is nothing to sign: `url` is
 * the API's own streaming endpoint, `expiresAt` is null and `direct` is false — fetch
 * it with the same credentials as this request.
 */
export interface AttachmentDownloadLink {
  url: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  expiresAt: string | null;
  direct: boolean;
}
