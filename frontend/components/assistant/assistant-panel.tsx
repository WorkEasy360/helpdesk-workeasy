'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Loader2, MessageSquarePlus, Send, X } from 'lucide-react';
import { PERMISSIONS, type AssistantProposal } from '@digisoft/shared';
import { assistantService } from '@/services/assistant.service';
import { useAuthStore } from '@/stores/auth.store';
import { ApiError, apiPatch, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AssistantAvatar } from './assistant-avatar';

/**
 * The assistant panel — see docs/AI-ASSISTANT-UI.md.
 *
 * A launcher fixed to the bottom-right of every signed-in page, opening a fixed-size
 * chat window above it. The conversation lives in this browser tab and nowhere else:
 * the server keeps no transcript.
 */

const STORAGE_KEY = 'digisoft-assistant-thread';
/** The server accepts this many turns of history; sending more is waste. */
const MAX_HISTORY = 12;

/** What a turn holds in memory. Only `id`, `role` and `text` are ever stored. */
interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  link?: { label: string; path: string } | null;
  proposal?: AssistantProposal | null;
  actionNote?: string | null;
  usedTools?: string[];
  failed?: boolean;
  confirmed?: 'pending' | 'done' | 'failed';
  confirmError?: string;
}

/**
 * Read during the first render rather than in an effect: `setState` in an effect trips
 * React's lint rule and costs a cascading render. Safe because the panel starts closed,
 * so none of the restored conversation reaches the server-rendered markup.
 */
function loadThread(): Turn[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    // Private mode, blocked storage — the thread just lasts this page view.
    return [];
  }
}

/**
 * Only the words are stored. A proposal is deliberately dropped: when the tab comes
 * back the world may have moved on, and a confirm button that no longer reflects the
 * server is a lie.
 */
function saveThread(turns: Turn[]): void {
  try {
    const bare = turns.slice(-40).map((turn) => ({ id: turn.id, role: turn.role, text: turn.text }));
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bare));
  } catch {
    // Nothing to do: the conversation is still in React state.
  }
}

/** What the panel shows for the failures a user can act on. */
function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The assistant could not answer that. Try again in a moment.';
  }
  if (error.status === 429) {
    return 'This organization has used its assistant questions for today. The allowance resets at midnight UTC.';
  }
  if (error.status === 502) return 'The model is unavailable right now. Try again in a moment.';
  if (error.status === 503) return 'The assistant is not configured for this organization yet.';
  // 401 is handled by the API client, which ends the session.
  return error.message;
}

export function AssistantPanel() {
  const can = useAuthStore((state) => state.can);
  const allowed = can(PERMISSIONS.AI_USE);

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>(loadThread);
  const [question, setQuestion] = useState('');
  const [thinking, setThinking] = useState(false);

  const fabRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    saveThread(turns);
  }, [turns]);

  // Escape closes and hands focus back to the launcher, which stays mounted.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      fabRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turns, thinking]);

  // Only once the chat is opened: the panel should not cost a request on every page.
  const welcome = useQuery({
    queryKey: ['assistant', 'welcome'],
    queryFn: assistantService.welcome,
    enabled: allowed && open,
    staleTime: 60_000,
  });

  const ask = useCallback(
    async (text: string) => {
      const asked = text.trim();
      if (!asked || thinking) return;

      const history = turns
        .filter((turn) => !turn.failed)
        .slice(-MAX_HISTORY)
        .map((turn) => ({ role: turn.role, content: turn.text }));

      setTurns((current) => [...current, { id: `q-${Date.now()}`, role: 'user', text: asked }]);
      setQuestion('');
      setThinking(true);

      try {
        const answer = await assistantService.ask({ question: asked, history });
        setTurns((current) => [
          ...current,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            text: answer.text,
            link: answer.link,
            proposal: answer.proposal,
            actionNote: answer.actionNote,
            usedTools: answer.usedTools,
          },
        ]);
        await queryClient.invalidateQueries({ queryKey: ['assistant', 'welcome'] });
      } catch (error) {
        setTurns((current) => [
          ...current,
          { id: `e-${Date.now()}`, role: 'assistant', text: describeError(error), failed: true },
        ]);
      } finally {
        setThinking(false);
      }
    },
    [thinking, turns, queryClient],
  );

  /**
   * Confirming calls the proposal's own `request` through the product's normal API
   * client — the same endpoint the ticket page uses, which validates and audits for
   * real. A change is reported as done only once that endpoint says so.
   */
  const confirm = useCallback(
    async (turnId: string, proposal: AssistantProposal) => {
      setTurns((current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, confirmed: 'pending' } : turn)),
      );
      try {
        if (proposal.request.method === 'PATCH') {
          await apiPatch(proposal.request.path, proposal.request.body);
        } else {
          await apiPost(proposal.request.path, proposal.request.body);
        }
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, confirmed: 'done' } : turn)),
        );
        // Whatever the change touched, open screens should stop showing the old value.
        await queryClient.invalidateQueries();
      } catch (error) {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId
              ? { ...turn, confirmed: 'failed', confirmError: describeError(error) }
              : turn,
          ),
        );
      }
    },
    [queryClient],
  );

  if (!allowed) return null;

  const stubbed = welcome.data?.provider === 'STUB' || welcome.data?.enabled === false;

  return (
    <>
      {open ? (
        <section className="c-chatbox" role="dialog" aria-label="Assistant">
          <header className="c-chatbox-head">
            <span className="flex min-w-0 items-center gap-2">
              <span className="c-agent-chip">
                <AssistantAvatar className="h-4 w-4" />
              </span>
              <span className="font-medium text-foreground">Assistant</span>
            </span>
            <span className="flex items-center gap-1">
              {turns.length > 0 ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setTurns([])}
                  aria-label="Clear the conversation"
                  title="Clear the conversation"
                >
                  <MessageSquarePlus className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setOpen(false);
                  fabRef.current?.focus();
                }}
                aria-label="Close the assistant"
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          </header>

          <div className="c-chatbox-body" ref={bodyRef} aria-live="polite">
            {stubbed ? (
              <p className="c-alert" data-tone="info">
                <span>
                  No model is configured for this organization, so answers come from the built-in
                  assistant and are limited to what it can look up.
                </span>
              </p>
            ) : null}

            {turns.length === 0 ? (
              <div className="c-chat-welcome">
                <p className="text-base text-body">
                  Ask about tickets, people or how the team is doing. I can prepare a change for you
                  to confirm.
                </p>
                {(welcome.data?.suggestions ?? []).map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="c-chat-suggestion"
                    onClick={() => void ask(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="c-chat-turn" data-role={turn.role}>
                  <p
                    className={cn('c-chat-bubble', turn.failed && 'bg-error-soft text-error-text')}
                    data-role={turn.role}
                  >
                    {turn.text}
                  </p>

                  {turn.actionNote ? (
                    <p className="text-xs text-secondary">{turn.actionNote}</p>
                  ) : null}

                  {turn.link ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={turn.link.path} onClick={() => setOpen(false)}>
                        Open {turn.link.label}
                        <ArrowRight className="h-4 w-4" aria-hidden />
                      </Link>
                    </Button>
                  ) : null}

                  {turn.proposal ? (
                    <ProposalCard
                      proposal={turn.proposal}
                      state={turn.confirmed}
                      error={turn.confirmError}
                      onConfirm={() => {
                        if (turn.proposal) void confirm(turn.id, turn.proposal);
                      }}
                      onNavigate={() => setOpen(false)}
                    />
                  ) : null}

                  {turn.usedTools && turn.usedTools.length > 0 ? (
                    <p className="text-xs text-secondary">Checked: {turn.usedTools.join(', ')}</p>
                  ) : null}
                </div>
              ))
            )}

            {thinking ? (
              <p className="c-chat-bubble flex items-center gap-2" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking…
              </p>
            ) : null}
          </div>

          <form
            className="c-chatbox-foot"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(question);
            }}
          >
            <label htmlFor="assistant-question" className="sr-only">
              Ask the assistant
            </label>
            <textarea
              ref={inputRef}
              id="assistant-question"
              className="c-textarea c-chat-input"
              rows={1}
              maxLength={2000}
              placeholder="Ask about tickets, people or the team…"
              value={question}
              disabled={thinking}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline, as every chat box does.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              disabled={thinking || question.trim().length === 0}
              aria-label="Send"
            >
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          </form>

          <p className="c-chatbox-note">Nothing changes until you confirm it.</p>
        </section>
      ) : null}

      {/* The launcher stays mounted while the chat is open, and swaps to a close icon. */}
      <button
        ref={fabRef}
        type="button"
        className="c-fab"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close the assistant' : 'Ask the assistant'}
        title={open ? 'Close the assistant' : 'Ask the assistant'}
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <AssistantAvatar className="c-fab-face" />}
      </button>
    </>
  );
}

/**
 * The confirmation card: the title, the facts that were checked, one sentence on what
 * will happen, and the button. Nothing changes until that button is pressed.
 */
function ProposalCard({
  proposal,
  state,
  error,
  onConfirm,
  onNavigate,
}: {
  proposal: AssistantProposal;
  state?: Turn['confirmed'];
  error?: string;
  onConfirm: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="c-chat-card">
      <p className="c-chat-card-title">{proposal.title}</p>

      <dl className="c-chat-card-facts">
        {proposal.summary.map(([label, value]) => (
          <div key={`${label}-${value}`} className="contents">
            <dt className="text-secondary">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="c-chat-card-effect">{proposal.effect}</p>

      {error ? (
        <p className="c-alert" data-tone="danger" role="alert">
          <span>{error}</span>
        </p>
      ) : null}

      {state === 'done' ? (
        <div className="c-toolbar">
          <span className="c-badge" data-tone="success">
            <span className="c-dot" aria-hidden />
            Done
          </span>
          {proposal.done ? (
            <Button asChild variant="outline" size="sm">
              <Link href={proposal.done.path} onClick={onNavigate}>
                Open {proposal.done.label}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={proposal.danger ? 'destructive' : 'default'}
          loading={state === 'pending'}
          onClick={onConfirm}
        >
          <Check className="h-4 w-4" aria-hidden />
          {proposal.confirmLabel}
        </Button>
      )}
    </div>
  );
}
