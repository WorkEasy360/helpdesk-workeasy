import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';
import { CONTENT_VISIBILITIES } from './kb';
import { slugSchema } from './slug';

export const TOPIC_TYPES = ['QUESTION', 'DISCUSSION', 'IDEA', 'PROBLEM', 'ANNOUNCEMENT'] as const;
export type TopicType = (typeof TOPIC_TYPES)[number];

export const TOPIC_STATUSES = ['OPEN', 'ANSWERED', 'CLOSED'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

export const MODERATION_STATUSES = ['PENDING', 'PUBLISHED', 'REJECTED'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const communityCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: optionalField(z.string().trim().max(500)),
  visibility: z.enum(CONTENT_VISIBILITIES).default('PUBLIC'),
  position: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});
export type CommunityCategoryInput = z.infer<typeof communityCategorySchema>;
export type CommunityCategoryFormValues = z.input<typeof communityCategorySchema>;

export const updateCommunityCategorySchema = patchSchema(communityCategorySchema);
export type UpdateCommunityCategoryInput = z.infer<typeof updateCommunityCategorySchema>;

export const createTopicSchema = z.object({
  categoryId: z.string().min(1),
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(1).max(20_000),
  type: z.enum(TOPIC_TYPES).default('QUESTION'),
});
export type CreateTopicInput = z.infer<typeof createTopicSchema>;
export type TopicFormValues = z.input<typeof createTopicSchema>;

export const updateTopicSchema = z.object({
  title: z.string().trim().min(5).max(200).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  type: z.enum(TOPIC_TYPES).optional(),
  categoryId: z.string().min(1).optional(),
});
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>;

/** Agent-only controls; a topic's author can never set these on their own topic. */
export const moderateTopicSchema = z.object({
  moderation: z.enum(MODERATION_STATUSES).optional(),
  status: z.enum(TOPIC_STATUSES).optional(),
  isPinned: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  categoryId: z.string().min(1).optional(),
});
export type ModerateTopicInput = z.infer<typeof moderateTopicSchema>;

export const createReplySchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});
export type CreateReplyInput = z.infer<typeof createReplySchema>;

export const moderateReplySchema = z.object({
  moderation: z.enum(MODERATION_STATUSES).optional(),
  isAnswer: z.boolean().optional(),
});
export type ModerateReplyInput = z.infer<typeof moderateReplySchema>;

export const listTopicsQuerySchema = paginationQuerySchema.extend({
  categoryId: z.string().min(1).optional(),
  type: z.enum(TOPIC_TYPES).optional(),
  status: z.enum(TOPIC_STATUSES).optional(),
  moderation: z.enum(MODERATION_STATUSES).optional(),
  mine: queryBoolean.optional(),
  unanswered: queryBoolean.optional(),
});
export type ListTopicsQuery = z.infer<typeof listTopicsQuerySchema>;
