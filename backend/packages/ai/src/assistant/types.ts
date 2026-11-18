import type { AssistantProposal } from '@digisoft/shared';

/**
 * The workspace assistant's vocabulary. Everything here is product-independent — the
 * Helpdesk's own tools, actions and pages are in `specs.ts`. See
 * backend/docs/AI-ASSISTANT.md.
 */

/** A read-only lookup the model may ask for. */
export interface AssistantToolSpec {
  name: string;
  /** What it returns, in one line — this is what the model chooses from. */
  description: string;
  /** The argument shape, written for the model to read, not parsed. */
  args: string;
  /** Every permission the caller needs. `null` means any member of the workspace. */
  permission: string[] | null;
}

/** A change the model may propose. It is never executed by the model. */
export interface AssistantActionSpec {
  kind: string;
  description: string;
  args: string;
  permission: string[] | null;
}

/** A page the assistant may link to. */
export interface AssistantPageSpec {
  key: string;
  label: string;
  path: string;
  permission: string[] | null;
}

/** Who is asking, and what they are allowed to see. */
export interface AssistantContext {
  organizationName: string;
  organizationSlug: string;
  memberName: string;
  memberEmail: string;
  roles: string[];
  timezone: string;
  /** Today where the organization is, as YYYY-MM-DD. */
  today: string;
  /** The tools, actions and pages this member's role may use. */
  tools: AssistantToolSpec[];
  actions: AssistantActionSpec[];
  pages: AssistantPageSpec[];
  /** The organization's own prompt guidance — tone, product names, languages. */
  guidance?: string | null;
}

/** One turn of the conversation, as it goes to the model. */
export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** The model asked for a tool. */
export interface AssistantToolCall {
  type: 'tool';
  tool: string;
  args: Record<string, unknown>;
}

/** The model answered. */
export interface AssistantAnswerReply {
  type: 'answer';
  text: string;
  /** A page key from the list, or `<record>:<id>`, or null. */
  navigate: string | null;
  /** `{ kind, ...args }`, or null. Checked server-side before it is ever shown. */
  action: Record<string, unknown> | null;
}

export type AssistantReply = AssistantToolCall | AssistantAnswerReply;

/** What a tool runner gives back. Errors are reported to the model, not thrown. */
export type AssistantToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type { AssistantProposal };

/** One model call, abstracted so the provider can be swapped or stubbed. */
export interface JsonCompletionProvider {
  readonly kind: string;
  readonly model: string;
  /**
   * Returns the model's raw text, which the caller parses as one JSON object, plus
   * what the call cost.
   */
  complete(input: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens: number;
  }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
}
