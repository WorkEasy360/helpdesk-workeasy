import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { optionalField, queryBoolean, patchSchema } from './field';
import { slugSchema } from './slug';

export const CONTENT_VISIBILITIES = ['PUBLIC', 'PORTAL_USERS', 'AGENTS_ONLY'] as const;
export type ContentVisibility = (typeof CONTENT_VISIBILITIES)[number];

export const ARTICLE_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const kbCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  description: optionalField(z.string().trim().max(500)),
  icon: optionalField(z.string().trim().max(40)),
  parentId: optionalField(z.string().min(1)),
  visibility: z.enum(CONTENT_VISIBILITIES).default('PUBLIC'),
  position: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});
export type KbCategoryInput = z.infer<typeof kbCategorySchema>;
export type KbCategoryFormValues = z.input<typeof kbCategorySchema>;

export const updateKbCategorySchema = patchSchema(kbCategorySchema);
export type UpdateKbCategoryInput = z.infer<typeof updateKbCategorySchema>;

export const kbArticleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  summary: optionalField(z.string().trim().max(500)),
  /** Markdown; rendered without raw HTML on both the portal and the agent preview. */
  body: z.string().trim().min(1).max(100_000),
  categoryId: optionalField(z.string().min(1)),
  status: z.enum(ARTICLE_STATUSES).default('DRAFT'),
  visibility: z.enum(CONTENT_VISIBILITIES).default('PUBLIC'),
  keywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  seoTitle: optionalField(z.string().trim().max(200)),
  seoDescription: optionalField(z.string().trim().max(320)),
  position: z.coerce.number().int().min(0).max(9999).default(0),
});
export type KbArticleInput = z.infer<typeof kbArticleSchema>;
export type KbArticleFormValues = z.input<typeof kbArticleSchema>;

export const updateKbArticleSchema = patchSchema(kbArticleSchema);
export type UpdateKbArticleInput = z.infer<typeof updateKbArticleSchema>;

export const listKbArticlesQuerySchema = paginationQuerySchema.extend({
  categoryId: z.string().min(1).optional(),
  status: z.enum(ARTICLE_STATUSES).optional(),
  visibility: z.enum(CONTENT_VISIBILITIES).optional(),
  authorId: z.string().min(1).optional(),
  mine: queryBoolean.optional(),
});
export type ListKbArticlesQuery = z.infer<typeof listKbArticlesQuerySchema>;

export const articleFeedbackSchema = z.object({
  isHelpful: z.boolean(),
  comment: optionalField(z.string().trim().max(1000)),
});
export type ArticleFeedbackInput = z.infer<typeof articleFeedbackSchema>;

export const kbSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  categoryId: z.string().min(1).optional(),
});
export type KbSearchQuery = z.infer<typeof kbSearchQuerySchema>;
