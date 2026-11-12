import { z } from 'zod';
import { optionalField } from './field';

export const AI_PROVIDERS = ['ANTHROPIC', 'HEURISTIC'] as const;
export type AiProviderKind = (typeof AI_PROVIDERS)[number];

export const AI_INSIGHT_TYPES = [
  'SUMMARY',
  'SENTIMENT',
  'INTENT',
  'SUGGESTED_REPLY',
  'KB_SUGGESTIONS',
] as const;
export type AiInsightType = (typeof AI_INSIGHT_TYPES)[number];

export const SENTIMENT_LABELS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'FRUSTRATED'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

/**
 * Models this product will accept for the Anthropic provider. Pinned rather than free
 * text so a typo cannot become a silent per-request failure, and so the settings screen
 * can show what each one costs.
 */
export const ANTHROPIC_MODEL_OPTIONS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', inputPerMTok: 5, outputPerMTok: 25 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', inputPerMTok: 2, outputPerMTok: 10 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', inputPerMTok: 10, outputPerMTok: 50 },
] as const;

export const aiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS).optional(),
  model: z.string().trim().min(1).max(80).optional(),
  /** Write-only; an omitted key keeps the stored one, an empty string clears it. */
  apiKey: z.string().max(400).optional(),
  isEnabled: z.boolean().optional(),
  summaryEnabled: z.boolean().optional(),
  sentimentEnabled: z.boolean().optional(),
  intentEnabled: z.boolean().optional(),
  suggestedReplyEnabled: z.boolean().optional(),
  autoAnalyse: z.boolean().optional(),
  /**
   * Assistant questions per day for the whole organization; 0 means no limit. The
   * assistant is always on, so this is a spend guard and never a way to switch it off.
   */
  assistantDailyLimit: z.coerce.number().int().min(0).max(100_000).optional(),
  monthlyTokenBudget: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  promptGuidance: optionalField(z.string().trim().max(2000)),
});
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;
export type AiSettingsFormValues = z.input<typeof aiSettingsSchema>;

export const generateInsightSchema = z.object({
  type: z.enum(['SUMMARY', 'SENTIMENT', 'INTENT', 'SUGGESTED_REPLY']),
  /** Regenerate even when a recent insight of this type exists. */
  refresh: z.boolean().default(false),
});
export type GenerateInsightInput = z.infer<typeof generateInsightSchema>;
