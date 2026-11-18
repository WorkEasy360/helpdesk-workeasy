'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { MessageCircle, Send, X } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { chatWidgetService } from '@/services/chat.service';
import type { ChatMessageDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

import { SOCKET_URL } from '@/lib/env';

interface Line {
  id: string;
  body: string;
  direction: 'INBOUND' | 'OUTBOUND';
  author?: string;
  createdAt: string;
}

const toLine = (message: ChatMessageDto): Line => ({
  id: message.id,
  body: message.bodyText,
  direction: message.direction,
  author: message.authorUser
    ? `${message.authorUser.firstName} ${message.authorUser.lastName}`.trim()
    : undefined,
  createdAt: message.createdAt,
});

/** Per help center, per tab: survives a reload but not closing the tab. */
const storageKey = (slug: string) => `digisoft-chat:${slug}`;

function readStoredToken(slug: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}

function storeToken(slug: string, token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(storageKey(slug), token);
    else window.sessionStorage.removeItem(storageKey(slug));
  } catch {
    // Storage blocked (private mode, disabled cookies): the chat still works, it just
    // will not survive a reload.
  }
}

/**
 * The help center's chat widget. It keeps the session token in sessionStorage for this
 * tab only, so a reload resumes the conversation instead of losing it, listens on
 * its own socket namespace for the agent's replies, and falls back to nothing more than
 * a form if chat is switched off for this organization.
 */
export function ChatWidget({ slug }: { slug: string }) {
  const api = chatWidgetService(slug);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState({ name: '', email: '', message: '' });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const config = useQuery({ queryKey: ['chat-widget', slug], queryFn: api.config });

  // Resume a conversation this tab already started, unless it has since ended or the
  // token is no longer accepted.
  useEffect(() => {
    const stored = readStoredToken(slug);
    if (!stored) {
      return;
    }
    let cancelled = false;
    void chatWidgetService(slug)
      .transcript(stored)
      .then((transcript) => {
        if (cancelled) return;
        if (transcript.session.status === 'ENDED') {
          storeToken(slug, null);
          return;
        }
        setToken(stored);
        setLines(transcript.messages.map(toLine));
      })
      .catch(() => {
        if (!cancelled) storeToken(slug, null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const socket: Socket = io(`${SOCKET_URL}/chat`, {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('chat.message', (message: Line & { sessionId: string }) => {
      setLines((current) =>
        current.some((line) => line.id === message.id) ? current : [...current, message],
      );
    });
    socket.on('chat.ended', () => {
      setEnded(true);
      storeToken(slug, null);
    });
    return () => {
      socket.close();
    };
  }, [token, slug]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  if (!config.data?.enabled) {
    return null;
  }

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.start({
        name: draft.name || null,
        email: draft.email || null,
        message: draft.message,
        pageUrl: typeof window === 'undefined' ? null : window.location.href,
      });
      setToken(result.token);
      storeToken(slug, result.token);
      const transcript = await api.transcript(result.token);
      setLines(transcript.messages.map(toLine));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to start the chat.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!token || !body.trim()) {
      return;
    }
    const text = body;
    setBody('');
    try {
      const created = await api.send(token, text);
      setLines((current) => [
        ...current,
        { id: created.id, body: text, direction: 'INBOUND', createdAt: new Date().toISOString() },
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Message not sent.');
      setBody(text);
    }
  };

  return (
    <>
      {open ? (
        <section aria-label="Live chat" className="c-chatbox bottom-20 h-[28rem]">
          <header className="c-chatbox-header">
            <span>{config.data.name}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close chat">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          {!token ? (
            <form className="flex-1 space-y-3 overflow-y-auto p-4" onSubmit={start}>
              <p className="text-base text-muted-foreground">{config.data.greeting}</p>
              <Input
                placeholder="Your name"
                aria-label="Your name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <Input
                type="email"
                placeholder="Email address"
                aria-label="Email address"
                required={config.data.requireEmail}
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
              <Textarea
                rows={3}
                placeholder="How can we help?"
                aria-label="Your message"
                required
                value={draft.message}
                onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              />
              {error ? <p role="alert" className="text-base text-destructive">{error}</p> : null}
              <Button type="submit" className="w-full" loading={busy}>
                Start chatting
              </Button>
            </form>
          ) : (
            <>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {lines.map((line) => (
                  <div
                    key={line.id}
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-base ${
                      line.direction === 'INBOUND' ? 'ml-auto bg-surface-muted' : 'bg-accent-soft text-accent-strong'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{line.body}</p>
                    {line.direction === 'OUTBOUND' && line.author ? (
                      <p className="mt-1 text-xs text-muted-foreground">{line.author}</p>
                    ) : null}
                  </div>
                ))}
                {ended ? (
                  <p className="text-center text-xs text-muted-foreground">
                    This chat has ended. We will follow up on your request by email.
                  </p>
                ) : null}
                <div ref={bottom} />
              </div>

              {!ended ? (
                <div className="flex gap-2 border-t border-border p-3">
                  <Input
                    value={body}
                    placeholder="Type a message"
                    aria-label="Message"
                    onChange={(event) => setBody(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <Button size="icon" aria-label="Send message" onClick={() => void send()}>
                    <Send className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Hide chat' : 'Chat with us'}
        className="c-fab bottom-4"
      >
        {/* `c-fab-face` rather than a size utility: the launcher sizes its own glyph,
            and a utility here would win over it. */}
        {open ? <X className="c-fab-face" aria-hidden /> : <MessageCircle className="c-fab-face" aria-hidden />}
      </button>
    </>
  );
}
