import { z } from 'zod';

/**
 * The conversational workspace assistant — the chat button on every agent page.
 * Distinct from the per-ticket insights in `ai.ts`: this one answers questions from
 * the organization's live data, links to pages, and *proposes* changes that the agent
 * confirms. See backend/docs/AI-ASSISTANT.md.
 */

/** A question may be this long; anything more is rejected rather than truncated. */
export const ASSISTANT_MAX_QUESTION = 2_000;
/** How much history the client sends back, newest last. */
export const ASSISTANT_HISTORY_TURNS = 12;

export const assistantRoleSchema = z.enum(['user', 'assistant']);
export type AssistantRole = z.infer<typeof assistantRoleSchema>;

export const assistantHistoryTurnSchema = z.object({
  role: assistantRoleSchema,
  content: z.string().max(ASSISTANT_MAX_QUESTION),
});
export type AssistantHistoryTurn = z.infer<typeof assistantHistoryTurnSchema>;

export const assistantAskSchema = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(ASSISTANT_MAX_QUESTION),
  /**
   * The conversation so far, as the browser tab holds it. The server keeps no
   * conversations, so this is the only history there is — and it is never trusted as
   * authority: every tool and endpoint re-checks the signed-in user.
   */
  history: z.array(assistantHistoryTurnSchema).max(ASSISTANT_HISTORY_TURNS).default([]),
});
export type AssistantAskInput = z.infer<typeof assistantAskSchema>;

/** A label/value row on a confirmation card. */
export type AssistantSummaryRow = [string, string];

/**
 * A change the assistant has checked and is offering. Nothing happens until the agent
 * presses the button, and when they do the frontend calls `request` — the product's own
 * endpoint, the same one its pages use, which validates and audits for real.
 */
export interface AssistantProposal {
  kind: string;
  /** "Move ticket #214 to Resolved". */
  title: string;
  /** The facts that were checked, for the agent to read before confirming. */
  summary: AssistantSummaryRow[];
  /** One sentence saying what pressing the button will do. */
  effect: string;
  confirmLabel: string;
  /** Red button: closes, cancels and anything an agent would want to think about. */
  danger: boolean;
  request: {
    method: 'POST' | 'PATCH';
    /** Relative to the API base, e.g. `/tickets/abc/resolve`. */
    path: string;
    body: Record<string, unknown>;
  };
  /** Where to send the agent afterwards. */
  done?: { label: string; path: string };
}

/** Where an answer offers to take the agent. Resolved server-side against their role. */
export interface AssistantLink {
  label: string;
  /** A frontend route, e.g. `/tickets/abc`. */
  path: string;
}

export interface AssistantAnswer {
  text: string;
  link: AssistantLink | null;
  proposal: AssistantProposal | null;
  /**
   * The model suggested a change, the server checked it and refused. Shown as a hint
   * under the message, with no card — kept separate from `text` so the UI never has to
   * pick a refusal out of prose.
   */
  actionNote: string | null;
  /** Tool names used, in order — shown as a quiet "checked:" line under the answer. */
  usedTools: string[];
  /** Questions left in today's allowance, or null when there is no limit. */
  remainingToday: number | null;
}

/**
 * What the chat shows before the first question.
 *
 * `enabled` is always true and is kept only so the response matches the shared
 * assistant-UI contract: this product has no on/off switch, and an organization that
 * has configured no model provider still gets a working chat from the built-in
 * deterministic one. The only thing that can hide the assistant is the `ai.use`
 * permission, which stops the launcher rendering at all.
 */
export interface AssistantWelcome {
  enabled: boolean;
  /**
   * Which model is answering: `ANTHROPIC`, or `STUB` when none is configured. The panel
   * says so above the conversation rather than letting the stub pass for a model.
   */
  provider: string | null;
  suggestions: string[];
  /** Questions per day for the whole organization; 0 means no limit. */
  dailyLimit: number;
  /** Questions left today, or null when there is no limit. */
  remainingToday: number | null;
}
