import { PERMISSIONS } from '@digisoft/shared';
import { AiError } from '../types';
import {
  ASSISTANT_LIMITS,
  assistantSystem,
  parseAssistantReply,
  plainText,
  runAssistantTurn,
  toolResultMessage,
} from './loop';
import { ASSISTANT_PROMPT } from './prompt';
import {
  DEFAULT_GEMINI_MODEL,
  GeminiJsonProvider,
  StubJsonProvider,
  createAssistantProvider,
} from './providers';
import { assistantCapabilities } from './specs';
import type { AssistantContext, JsonCompletionProvider } from './types';

/** A provider that replays a fixed script, so the loop can be driven exactly. */
function scripted(replies: string[]): JsonCompletionProvider & { calls: number } {
  let index = 0;
  return {
    kind: 'SCRIPTED',
    model: 'scripted',
    get calls() {
      return index;
    },
    async complete() {
      const text = replies[index] ?? replies[replies.length - 1] ?? '';
      index += 1;
      return { text, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const context = (overrides: Partial<AssistantContext> = {}): AssistantContext => ({
  organizationName: 'Acme Support',
  organizationSlug: 'acme',
  memberName: 'Demo Agent',
  memberEmail: 'agent@example.test',
  roles: ['AGENT'],
  timezone: 'Asia/Kolkata',
  today: '2026-11-10',
  tools: [],
  actions: [],
  pages: [],
  ...overrides,
});

describe('parseAssistantReply', () => {
  it('reads a tool request', () => {
    const reply = parseAssistantReply('{"type":"tool","tool":"get_ticket","args":{"ticketNumber":4}}');
    expect(reply).toEqual({ type: 'tool', tool: 'get_ticket', args: { ticketNumber: 4 } });
  });

  it('reads an answer, defaulting the optional fields', () => {
    const reply = parseAssistantReply('{"type":"answer","text":"Two tickets are open."}');
    expect(reply).toEqual({ type: 'answer', text: 'Two tickets are open.', navigate: null, action: null });
  });

  it('tolerates a fenced code block', () => {
    const reply = parseAssistantReply('```json\n{"type":"answer","text":"hi"}\n```');
    expect(reply.type).toBe('answer');
  });

  it('rejects a tool request with no tool named', () => {
    expect(() => parseAssistantReply('{"type":"tool","args":{}}')).toThrow(AiError);
  });

  it('rejects an answer with no text', () => {
    expect(() => parseAssistantReply('{"type":"answer","text":"  "}')).toThrow(AiError);
  });

  it('rejects anything that is neither', () => {
    expect(() => parseAssistantReply('{"type":"write","sql":"drop table tickets"}')).toThrow(AiError);
  });

  it('coerces a non-object args to an empty object rather than failing', () => {
    const reply = parseAssistantReply('{"type":"tool","tool":"x","args":"nope"}');
    expect(reply).toMatchObject({ type: 'tool', args: {} });
  });
});

describe('runAssistantTurn', () => {
  const answer = (text: string) => JSON.stringify({ type: 'answer', text, navigate: null, action: null });

  it('answers straight away when no tool is needed', async () => {
    const provider = scripted([answer('Nothing is overdue.')]);
    const result = await runAssistantTurn({
      provider,
      system: 'system',
      history: [],
      question: 'Anything overdue?',
      runTool: async () => ({ ok: true, result: {} }),
    });
    expect(result.answer.text).toBe('Nothing is overdue.');
    expect(result.usedTools).toEqual([]);
  });

  it('runs the tool it asks for and feeds the result back', async () => {
    const provider = scripted([
      JSON.stringify({ type: 'tool', tool: 'helpdesk_overview', args: {} }),
      answer('One ticket is open.'),
    ]);
    const seen: string[] = [];
    const result = await runAssistantTurn({
      provider,
      system: 'system',
      history: [],
      question: 'How are we doing?',
      runTool: async (name) => {
        seen.push(name);
        return { ok: true, result: { open: 1 } };
      },
    });
    expect(seen).toEqual(['helpdesk_overview']);
    expect(result.usedTools).toEqual(['helpdesk_overview']);
    expect(result.answer.text).toBe('One ticket is open.');
  });

  it('corrects a malformed reply once, then gives up', async () => {
    const always = scripted(['not json at all']);
    await expect(
      runAssistantTurn({
        provider: always,
        system: 'system',
        history: [],
        question: 'hi',
        runTool: async () => ({ ok: true, result: {} }),
      }),
    ).rejects.toThrow(AiError);
    // One first attempt plus exactly one correction.
    expect(always.calls).toBe(ASSISTANT_LIMITS.maxCorrections + 1);
  });

  it('recovers when the correction works', async () => {
    const provider = scripted(['garbage', answer('Fixed.')]);
    const result = await runAssistantTurn({
      provider,
      system: 'system',
      history: [],
      question: 'hi',
      runTool: async () => ({ ok: true, result: {} }),
    });
    expect(result.answer.text).toBe('Fixed.');
  });

  it('stops asking for tools once the budget is spent', async () => {
    const provider = scripted([JSON.stringify({ type: 'tool', tool: 'search_tickets', args: {} })]);
    await expect(
      runAssistantTurn({
        provider,
        system: 'system',
        history: [],
        question: 'find everything',
        runTool: async () => ({ ok: true, result: {} }),
      }),
    ).rejects.toThrow(AiError);
  });

  it('passes a tool failure back to the model instead of throwing', async () => {
    const provider = scripted([
      JSON.stringify({ type: 'tool', tool: 'search_tickets', args: {} }),
      answer('I could not check that.'),
    ]);
    const result = await runAssistantTurn({
      provider,
      system: 'system',
      history: [],
      question: 'find everything',
      runTool: async () => ({ ok: false, error: 'You cannot read tickets.' }),
    });
    expect(result.answer.text).toBe('I could not check that.');
  });

  it('gives up when the deadline has passed', async () => {
    const provider = scripted([answer('too late')]);
    let clock = 0;
    await expect(
      runAssistantTurn({
        provider,
        system: 'system',
        history: [],
        question: 'hi',
        runTool: async () => ({ ok: true, result: {} }),
        now: () => (clock += ASSISTANT_LIMITS.timeoutMs + 1),
      }),
    ).rejects.toThrow(/too long/i);
  });
});

describe('toolResultMessage', () => {
  it('marks the result as data, with its tool named', () => {
    const message = toolResultMessage('get_ticket', { ok: true, result: { id: 'a' } });
    expect(message).toBe('<tool_result name="get_ticket">{"id":"a"}</tool_result>');
  });

  it('says so when it had to cut the result short', () => {
    const big = { text: 'x'.repeat(ASSISTANT_LIMITS.maxToolResultChars + 500) };
    const message = toolResultMessage('search_tickets', { ok: true, result: big });
    expect(message).toContain('truncated="true"');
    expect(message).toContain('cut short');
  });

  it('reports an error without pretending it was a result', () => {
    const message = toolResultMessage('x', { ok: false, error: 'nope' });
    expect(message).toContain('status="error"');
  });
});

describe('assistantCapabilities', () => {
  it('hides every tool and action a role cannot use', () => {
    const none = assistantCapabilities(() => false);
    // The overview needs no permission, so it is the one that survives.
    expect(none.tools.map((tool) => tool.name)).toEqual(['helpdesk_overview']);
    expect(none.actions).toEqual([]);
    expect(none.pages.map((page) => page.key)).toEqual(['dashboard']);
  });

  it('gives a read-only agent tools but no actions', () => {
    const readOnly = assistantCapabilities((p) => p === PERMISSIONS.TICKET_READ);
    expect(readOnly.tools.map((t) => t.name)).toContain('search_tickets');
    expect(readOnly.actions).toEqual([]);
  });

  it('offers an action only when every one of its permissions is held', () => {
    const assigner = assistantCapabilities(
      (p) => p === PERMISSIONS.TICKET_ASSIGN || p === PERMISSIONS.TICKET_READ,
    );
    expect(assigner.actions.map((a) => a.kind)).toEqual(['assign_ticket']);
  });

  it('never offers replying, merging or deleting', () => {
    const everything = assistantCapabilities(() => true);
    const kinds = everything.actions.map((action) => action.kind);
    expect(kinds).not.toContain('reply_to_customer');
    expect(kinds).not.toContain('merge_ticket');
    expect(kinds).not.toContain('delete_ticket');
  });
});

describe('assistantSystem', () => {
  it('names only the tools, actions and pages that were passed in', () => {
    const system = assistantSystem(ASSISTANT_PROMPT, context());
    expect(system).toContain('(none — answer from the context above');
    expect(system).toContain('(none — this member may not change anything');
  });

  it('carries the member and the workspace into the context block', () => {
    const system = assistantSystem(ASSISTANT_PROMPT, context());
    expect(system).toContain('organization: Acme Support');
    expect(system).toContain('member: Demo Agent <agent@example.test>');
    expect(system).toContain('today: 2026-11-10');
    expect(system).toContain('timezone: Asia/Kolkata');
  });

  it('appends the organization’s own guidance when it has some', () => {
    const system = assistantSystem(ASSISTANT_PROMPT, context({ guidance: 'Always answer in Hindi.' }));
    expect(system).toContain('Always answer in Hindi.');
  });
});

describe('the prompt', () => {
  it('states the rules the product cannot bend', () => {
    expect(ASSISTANT_PROMPT).toMatch(/never propose a reply/i);
    expect(ASSISTANT_PROMPT).toMatch(/merging and deleting cannot be undone/i);
    expect(ASSISTANT_PROMPT).toMatch(/resolution note/i);
    expect(ASSISTANT_PROMPT).toMatch(/one organization/i);
    expect(ASSISTANT_PROMPT).toMatch(/never reveal/i);
  });

  it('tells the model that tool text is data, not instructions', () => {
    // The prompt is hard-wrapped, so match on a single line's worth of it.
    expect(ASSISTANT_PROMPT).toMatch(/as data you are reading/i);
    expect(ASSISTANT_PROMPT).toMatch(/part of the ticket, not part of the/i);
  });
});

describe('StubJsonProvider', () => {
  it('asks for the overview first, then answers from what it got', async () => {
    const stub = new StubJsonProvider();
    const system = assistantSystem(ASSISTANT_PROMPT, context({
      tools: [{ name: 'helpdesk_overview', description: '', args: '{}', permission: null }],
    }));

    const first = await stub.complete({ system, messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(JSON.parse(first.text)).toMatchObject({ type: 'tool', tool: 'helpdesk_overview' });

    const second = await stub.complete({
      system,
      messages: [{ role: 'user', content: '<tool_result name="helpdesk_overview">{"open":2}</tool_result>' }],
      maxTokens: 100,
    });
    expect(JSON.parse(second.text)).toMatchObject({ type: 'answer' });
    expect(JSON.parse(second.text).text).toContain('{"open":2}');
  });

  it('never proposes an action', async () => {
    const stub = new StubJsonProvider();
    const reply = await stub.complete({ system: '', messages: [{ role: 'user', content: 'resolve #4' }], maxTokens: 100 });
    expect(JSON.parse(reply.text).action ?? null).toBeNull();
  });
});

describe('plainText', () => {
  it('strips the light markdown the prompt asks for', () => {
    expect(plainText('**bold** and `code`')).toBe('bold and code');
  });
});

describe('GeminiJsonProvider', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Captures the request and replies with whatever the test needs. */
  function stubFetch(reply: unknown, init: { ok?: boolean; status?: number } = {}) {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: string, options: RequestInit) => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: 'err',
      json: async () => reply,
      text: async () => JSON.stringify(reply),
      ...(calls.push({
        url: String(url),
        headers: options.headers as Record<string, string>,
        body: JSON.parse(String(options.body)),
      }) && {}),
    })) as unknown as typeof fetch;
    return calls;
  }

  const answer = {
    candidates: [{ content: { parts: [{ text: '{"type":"answer","text":"hi"}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
  };

  it('sends the system instruction, the turns and the token counts back', async () => {
    const calls = stubFetch(answer);
    const provider = new GeminiJsonProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const result = await provider.complete({
      system: 'SYSTEM',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
      maxTokens: 1500,
    });

    expect(result.text).toBe('{"type":"answer","text":"hi"}');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

    const call = calls[0]!;
    expect(call.url).toContain('models/gemini-2.5-flash:generateContent');
    // The key goes in a header, never the query string.
    expect(call.headers['x-goog-api-key']).toBe('k');
    expect(call.url).not.toContain('k');
    expect(call.body['systemInstruction']).toEqual({ parts: [{ text: 'SYSTEM' }] });
  });

  it('maps the assistant role to Gemini’s "model"', async () => {
    const calls = stubFetch(answer);
    await new GeminiJsonProvider({ apiKey: 'k' }).complete({
      system: 's',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
      maxTokens: 100,
    });
    expect((calls[0]!.body['contents'] as { role: string }[]).map((c) => c.role)).toEqual([
      'user',
      'model',
    ]);
  });

  it('asks for JSON and turns thinking off, so the budget is not spent reasoning', async () => {
    const calls = stubFetch(answer);
    await new GeminiJsonProvider({ apiKey: 'k' }).complete({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      maxTokens: 1500,
    });
    const config = calls[0]!.body['generationConfig'] as Record<string, unknown>;
    expect(config['responseMimeType']).toBe('application/json');
    expect(config['thinkingConfig']).toEqual({ thinkingBudget: 0 });
    expect(config['maxOutputTokens']).toBe(1500);
  });

  it('defaults the model when none is given', () => {
    expect(new GeminiJsonProvider({ apiKey: 'k' }).model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('reports the API error message, not a bare status', async () => {
    stubFetch({ error: { message: 'API key not valid' } }, { ok: false, status: 400 });
    await expect(
      new GeminiJsonProvider({ apiKey: 'bad' }).complete({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(/API key not valid/);
  });

  it('treats an empty candidate as a failure rather than an empty answer', async () => {
    stubFetch({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
    await expect(
      new GeminiJsonProvider({ apiKey: 'k' }).complete({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(/returned nothing.*MAX_TOKENS/);
  });

  it('surfaces a safety stop as a refusal', async () => {
    stubFetch({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
    await expect(
      new GeminiJsonProvider({ apiKey: 'k' }).complete({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
      }),
    ).rejects.toThrow(/declined/);
  });
});

describe('createAssistantProvider', () => {
  it('picks the provider the environment names', () => {
    expect(createAssistantProvider({ provider: 'GEMINI', apiKey: 'k' }).kind).toBe('GEMINI');
    expect(createAssistantProvider({ provider: 'ANTHROPIC', apiKey: 'k' }).kind).toBe('ANTHROPIC');
  });

  it('falls back to the stub without a key, whatever the provider says', () => {
    expect(createAssistantProvider({ provider: 'GEMINI', apiKey: null }).kind).toBe('STUB');
    expect(createAssistantProvider({ provider: 'ANTHROPIC' }).kind).toBe('STUB');
    expect(createAssistantProvider({ provider: 'HEURISTIC', apiKey: 'k' }).kind).toBe('STUB');
  });

  it('honours an explicit model over the provider default', () => {
    expect(createAssistantProvider({ provider: 'GEMINI', apiKey: 'k', model: 'gemini-2.0-flash' }).model)
      .toBe('gemini-2.0-flash');
    expect(createAssistantProvider({ provider: 'GEMINI', apiKey: 'k', model: '  ' }).model)
      .toBe(DEFAULT_GEMINI_MODEL);
  });
});
