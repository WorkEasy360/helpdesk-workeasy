import { AiError } from '../types';
import { parseJsonObject } from '../parse';
import type {
  AssistantContext,
  AssistantReply,
  AssistantToolOutcome,
  AssistantTurn,
  JsonCompletionProvider,
} from './types';

/** Limits on one question. Identical in every product — see the blueprint. */
export const ASSISTANT_LIMITS = {
  /** Read-only lookups per question. */
  maxTools: 4,
  /** Wall clock for the whole question, tools included. */
  timeoutMs: 50_000,
  maxOutputTokens: 1_500,
  /** A tool result longer than this is cut; the model is told it was cut. */
  maxToolResultChars: 12_000,
  /** One correction for a malformed reply, then the question fails. */
  maxCorrections: 1,
} as const;

/**
 * Turns the model's raw text into one reply, or throws. Tolerant of the usual
 * wrappers (a fenced code block, a sentence before the JSON) because a reply that is
 * *nearly* right should cost a correction, not the whole question.
 */
export function parseAssistantReply(raw: string): AssistantReply {
  const data = parseJsonObject(raw);
  const type = data['type'];

  if (type === 'tool') {
    const tool = typeof data['tool'] === 'string' ? data['tool'].trim() : '';
    if (!tool) throw new AiError('The reply asked for a tool but did not name one');
    const args = data['args'];
    return {
      type: 'tool',
      tool,
      args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    };
  }

  if (type === 'answer') {
    const text = typeof data['text'] === 'string' ? data['text'].trim() : '';
    if (!text) throw new AiError('The reply was an answer with no text');
    const navigate = typeof data['navigate'] === 'string' && data['navigate'].trim() ? data['navigate'].trim() : null;
    const action = data['action'];
    return {
      type: 'answer',
      text,
      navigate,
      action:
        action && typeof action === 'object' && !Array.isArray(action)
          ? (action as Record<string, unknown>)
          : null,
    };
  }

  throw new AiError('The reply was neither a tool request nor an answer');
}

/** Strips the light markdown the model is asked for, for plain-text contexts. */
export function plainText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`#]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A tool result, wrapped so the model can see where untrusted text begins and ends. */
export function toolResultMessage(name: string, outcome: AssistantToolOutcome): string {
  if (!outcome.ok) {
    return `<tool_result name="${name}" status="error">${outcome.error}</tool_result>`;
  }
  const body = JSON.stringify(outcome.result ?? null);
  const cut = body.length > ASSISTANT_LIMITS.maxToolResultChars;
  const shown = cut ? body.slice(0, ASSISTANT_LIMITS.maxToolResultChars) : body;
  return (
    `<tool_result name="${name}"${cut ? ' truncated="true"' : ''}>${shown}</tool_result>` +
    (cut ? '\n(The result was cut short. Narrow the search rather than assuming the rest.)' : '')
  );
}

export interface AssistantTurnInput {
  provider: JsonCompletionProvider;
  system: string;
  /** Earlier turns, oldest first. The new question is passed separately. */
  history: AssistantTurn[];
  question: string;
  /** Runs one tool. Unknown names must come back as `{ ok: false }`, never throw. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<AssistantToolOutcome>;
  now?: () => number;
}

export interface AssistantTurnResult {
  answer: Extract<AssistantReply, { type: 'answer' }>;
  usedTools: string[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * One question, start to finish: ask the model, run the read-only tools it asks for,
 * ask again, and stop at the first answer.
 *
 * The model never writes. It can only ask for tools from `runTool` — which the caller
 * has already filtered to the member's permissions — and the `action` on its answer is
 * a suggestion the caller still has to verify.
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + ASSISTANT_LIMITS.timeoutMs;

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    ...input.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user' as const, content: input.question },
  ];

  const usedTools: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let corrections = 0;

  // One pass per tool, plus the pass that answers, plus any corrections.
  const maxPasses = ASSISTANT_LIMITS.maxTools + 1 + ASSISTANT_LIMITS.maxCorrections;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (now() > deadline) {
      throw new AiError('The assistant took too long to answer. Try a narrower question.');
    }

    const completion = await input.provider.complete({
      system: input.system,
      messages,
      maxTokens: ASSISTANT_LIMITS.maxOutputTokens,
    });
    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;

    let reply: AssistantReply;
    try {
      reply = parseAssistantReply(completion.text);
    } catch (error) {
      // One correction, then the question fails — a model that cannot produce the
      // format twice in a row will not produce it on the third try either.
      corrections += 1;
      if (corrections > ASSISTANT_LIMITS.maxCorrections) {
        throw new AiError('The assistant could not produce a usable answer. Try asking again.');
      }
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content:
          'That was not valid. Reply with exactly one JSON object and nothing else: ' +
          'either {"type":"tool","tool":"<name>","args":{}} or ' +
          '{"type":"answer","text":"...","navigate":null,"action":null}. ' +
          `(${error instanceof Error ? error.message : 'unparseable'})`,
      });
      continue;
    }

    if (reply.type === 'answer') {
      return { answer: reply, usedTools, usage };
    }

    if (usedTools.length >= ASSISTANT_LIMITS.maxTools) {
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content:
          'You have used all the lookups allowed for this question. Answer now with what ' +
          'you already have, and say plainly what you could not check.',
      });
      continue;
    }

    const outcome = await input.runTool(reply.tool, reply.args);
    usedTools.push(reply.tool);
    messages.push({ role: 'assistant', content: completion.text });
    messages.push({ role: 'user', content: toolResultMessage(reply.tool, outcome) });
  }

  throw new AiError('The assistant could not finish this question. Try asking it more directly.');
}

/** The `<context>` block appended to the prompt, plus the reply format. */
export function assistantSystem(prompt: string, context: AssistantContext): string {
  return [
    prompt,
    '',
    '# Reply format',
    '',
    'Every reply is exactly one JSON object and nothing else. No prose around it, no code fence.',
    '',
    'To look something up:',
    '{"type":"tool","tool":"<tool name>","args":{ }}',
    '',
    'To answer:',
    '{"type":"answer","text":"<reply>","navigate":null,"action":null}',
    '',
    '`navigate` is one of the page keys below, or "<record>:<id>" for a record you found, or null.',
    '`action` is {"kind":"<action kind>", ...args} for one of the actions below, or null.',
    '',
    '# Context',
    '',
    `<context>`,
    `organization: ${context.organizationName}`,
    `member: ${context.memberName} <${context.memberEmail}>`,
    `roles: ${context.roles.join(', ') || 'none'}`,
    `timezone: ${context.timezone}`,
    `today: ${context.today}`,
    `</context>`,
    '',
    '# Tools you may use',
    '',
    context.tools.length
      ? context.tools
          .map((tool) => `- {"name": "${tool.name}", "args": ${tool.args}} — ${tool.description}`)
          .join('\n')
      : '(none — answer from the context above, or say you cannot check)',
    '',
    '# Actions you may propose',
    '',
    context.actions.length
      ? context.actions
          .map((action) => `- {"kind": "${action.kind}", ...${action.args}} — ${action.description}`)
          .join('\n')
      : '(none — this member may not change anything, so never propose an action)',
    '',
    '# Pages you may link to',
    '',
    context.pages.length
      ? context.pages.map((page) => `- ${page.key} — ${page.label}`).join('\n')
      : '(none)',
    ...(context.guidance
      ? ['', '# This organization’s own instructions', '', context.guidance.trim()]
      : []),
  ].join('\n');
}
