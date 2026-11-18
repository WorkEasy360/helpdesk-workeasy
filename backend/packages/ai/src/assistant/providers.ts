import Anthropic from '@anthropic-ai/sdk';
import { AiError } from '../types';
import { DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic';
import type { JsonCompletionProvider } from './types';

/**
 * The assistant needs a different shape from the four insight tasks: a multi-turn
 * conversation that comes back as one JSON object. This is that call, and nothing else
 * — the loop in `loop.ts` decides what to do with the text.
 */

export class AnthropicJsonProvider implements JsonCompletionProvider {
  readonly kind = 'ANTHROPIC';
  readonly model: string;
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(options: { apiKey: string; model: string; client?: Pick<Anthropic, 'messages'> }) {
    this.model = options.model;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  }

  async complete(input: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens: number;
  }) {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: [
          // The system block is identical for every turn of every conversation in an
          // organization, so it caches across questions.
          { type: 'text', text: input.system, cache_control: { type: 'ephemeral' } },
        ],
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      if (response.stop_reason === 'refusal') {
        throw new AiError('The assistant declined to answer this request');
      }

      return {
        text: response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
        usage: {
          inputTokens:
            response.usage.input_tokens +
            (response.usage.cache_read_input_tokens ?? 0) +
            (response.usage.cache_creation_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (error instanceof Anthropic.APIError) {
        throw new AiError(`Claude refused the request: ${error.message}`, error.status);
      }
      throw new AiError(error instanceof Error ? error.message : 'The assistant request failed');
    }
  }
}

/**
 * A local, deterministic stand-in, used in development and in the tests. It never
 * reaches the network and never guesses: it calls the overview tool once, then answers
 * with whatever that returned. That is enough to exercise the whole loop — the tool
 * round trip, the reply parsing, the permission filtering and the usage accounting —
 * without an API key.
 */
export class StubJsonProvider implements JsonCompletionProvider {
  readonly kind = 'STUB';
  readonly model = 'stub';

  async complete(input: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens: number;
  }) {
    const asked = [...input.messages].reverse().find((message) => message.role === 'user');
    const text = asked?.content ?? '';
    const usage = { inputTokens: 0, outputTokens: 0 };

    // A tool result is already in hand: answer from it.
    if (text.includes('<tool_result')) {
      const body = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</tool_result>')).trim();
      return {
        text: JSON.stringify({
          type: 'answer',
          text: `Here is what the workspace reports:\n\n${body.slice(0, 600)}`,
          navigate: null,
          action: null,
        }),
        usage,
      };
    }

    // The overview tool is always present, so this is safe for any product.
    const overview = /"name":\s*"([a-z_]*overview)"/.exec(input.system)?.[1];
    if (overview) {
      return { text: JSON.stringify({ type: 'tool', tool: overview, args: {} }), usage };
    }

    return {
      text: JSON.stringify({
        type: 'answer',
        text: 'The assistant is not configured with a model provider yet.',
        navigate: null,
        action: null,
      }),
      usage,
    };
  }
}


/** Default model when `AI_MODEL` is unset and the provider is Gemini. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Google Gemini, over the REST API.
 *
 * No SDK: the assistant needs exactly one call shape — a system instruction, a few
 * turns, one JSON object back — and `fetch` covers it without another dependency to
 * keep in step.
 *
 * Two details that matter for this use:
 * - `responseMimeType: application/json` makes the model return the reply object
 *   directly, so the loop's parser has nothing to strip.
 * - `thinkingBudget: 0` turns 2.5's reasoning off. Thinking tokens count against
 *   `maxOutputTokens`, so leaving it on can burn the whole budget and return an empty
 *   candidate — a silent failure that looks like a malformed reply.
 */
export class GeminiJsonProvider implements JsonCompletionProvider {
  readonly kind = 'GEMINI';
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(options: { apiKey: string; model?: string; endpoint?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.endpoint = options.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async complete(input: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens: number;
  }) {
    const url = `${this.endpoint}/models/${encodeURIComponent(this.model)}:generateContent`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // In the header, not the query string, so the key never lands in a log line.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: input.messages.map((message) => ({
            // Gemini calls the assistant side "model".
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: {
            maxOutputTokens: input.maxTokens,
            responseMimeType: 'application/json',
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });
    } catch (error) {
      throw new AiError(
        error instanceof Error ? `Could not reach Gemini: ${error.message}` : 'Could not reach Gemini',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = readGeminiError(detail) ?? response.statusText;
      throw new AiError(`Gemini refused the request: ${message}`, response.status);
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      throw new AiError('The assistant declined to answer this request');
    }

    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      // An empty candidate is almost always the token budget, not a model failure.
      throw new AiError(
        `Gemini returned nothing (finish reason: ${candidate?.finishReason ?? 'unknown'})`,
      );
    }

    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Pulls the human-readable part out of Gemini's error envelope. */
function readGeminiError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return body.slice(0, 200) || null;
  }
}

/**
 * The model caller for the workspace assistant.
 *
 * Credentials come from the deployment's environment, not from a per-organization
 * settings row: the assistant is a feature of the deployment and runs on the operator's
 * key. The per-ticket insights keep their own per-tenant configuration.
 *
 * Anything other than a configured `ANTHROPIC` falls back to the deterministic stub, so
 * the chat works out of the box and simply reports that it has no model behind it.
 */
export function createAssistantProvider(credentials: {
  provider: string;
  model?: string | null;
  apiKey?: string | null;
}): JsonCompletionProvider {
  const model = credentials.model?.trim() || null;
  if (credentials.apiKey) {
    if (credentials.provider === 'ANTHROPIC') {
      return new AnthropicJsonProvider({
        apiKey: credentials.apiKey,
        model: model ?? DEFAULT_ANTHROPIC_MODEL,
      });
    }
    if (credentials.provider === 'GEMINI') {
      return new GeminiJsonProvider({
        apiKey: credentials.apiKey,
        model: model ?? DEFAULT_GEMINI_MODEL,
      });
    }
  }
  return new StubJsonProvider();
}
