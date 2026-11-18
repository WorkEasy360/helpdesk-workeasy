'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, MessageSquare, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api-client';
import { chatService } from '@/services/chat.service';
import { ticketsService } from '@/services/tickets.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { PageHeader } from '@/components/layout/page-header';

/** The live chat inbox: what is waiting, what is in progress, and the conversation. */
export default function ChatInboxPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState('');

  const sessions = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => chatService.sessions({ page: 1, pageSize: 25 }),
    // Chat is live: new visitors also arrive over the socket, this keeps the list honest.
    refetchInterval: 10_000,
  });

  const transcript = useQuery({
    queryKey: ['chat-session', selected],
    queryFn: () => chatService.transcript(selected as string),
    enabled: selected !== null,
    refetchInterval: 5_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
    await queryClient.invalidateQueries({ queryKey: ['chat-session', selected] });
  };

  const accept = useMutation({
    mutationFn: (id: string) => chatService.accept(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Chat accepted — it is assigned to you');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to accept.'),
  });

  const reply = useMutation({
    mutationFn: (ticketId: string) => ticketsService.reply(ticketId, { bodyText: body, attachmentIds: [] }),
    onSuccess: async () => {
      setBody('');
      await refresh();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to send.'),
  });

  const end = useMutation({
    mutationFn: (id: string) => chatService.end(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Chat ended');
    },
  });

  const active = transcript.data;

  return (
    <>
      <PageHeader
        title="Live chat"
        description="Conversations from the help center widget. Each one is a ticket, so nothing is lost when the visitor leaves."
      />

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-md">Conversations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {sessions.isPending ? (
              <LoadingState />
            ) : sessions.isError ? (
              <ErrorState
                message={sessions.error instanceof ApiError ? sessions.error.message : 'Unable to load chats.'}
                onRetry={() => sessions.refetch()}
              />
            ) : sessions.data.items.length === 0 ? (
              <EmptyState
                title="No chats yet"
                description="Turn on a live chat channel and the widget appears in your help center."
              />
            ) : (
              <ul className="divide-y divide-border">
                {sessions.data.items.map((session) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(session.id)}
                      aria-current={selected === session.id ? 'true' : undefined}
                      className={`w-full px-3 py-3 text-left transition-colors hover:bg-surface-muted ${
                        selected === session.id ? 'bg-muted' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-base font-medium">
                          {session.visitorName ?? session.visitorEmail ?? 'Visitor'}
                        </span>
                        <Badge
                          variant={
                            session.status === 'QUEUED'
                              ? 'warning'
                              : session.status === 'ACTIVE'
                                ? 'success'
                                : 'default'
                          }
                        >
                          {session.status.toLowerCase()}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {session.ticket ? `#${session.ticket.ticketNumber} · ${session.ticket.subject}` : '—'}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(session.lastSeenAt)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {active ? (
          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="text-md">
                  {active.session.visitorName ?? active.session.visitorEmail ?? 'Visitor'}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {active.session.pageUrl ? `From ${active.session.pageUrl} · ` : ''}
                  started {formatDateTime(active.session.startedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {active.session.ticket ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/tickets/${active.session.ticket.id}`}>
                      Ticket #{active.session.ticket.ticketNumber}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Button>
                ) : null}
                {active.session.status === 'QUEUED' ? (
                  <Button size="sm" loading={accept.isPending} onClick={() => accept.mutate(active.session.id)}>
                    <Check className="h-4 w-4" aria-hidden />
                    Accept
                  </Button>
                ) : null}
                {active.session.status !== 'ENDED' ? (
                  <Button size="sm" variant="ghost" onClick={() => end.mutate(active.session.id)}>
                    End chat
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="max-h-[26rem] space-y-2 overflow-y-auto rounded-md border border-border p-3">
                {active.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[80%] rounded-lg px-3 py-2 text-base ${
                      message.direction === 'OUTBOUND'
                        ? 'ml-auto bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.bodyText}</p>
                    <p className="mt-1 text-xs opacity-70">
                      {message.authorUser
                        ? `${message.authorUser.firstName} ${message.authorUser.lastName}`
                        : (message.authorContact?.firstName ?? 'Visitor')}{' '}
                      · {formatDateTime(message.createdAt)}
                    </p>
                  </div>
                ))}
                {active.messages.length === 0 ? (
                  <p className="text-base text-muted-foreground">No messages yet.</p>
                ) : null}
              </div>

              {active.session.status !== 'ENDED' && active.session.ticket ? (
                <div className="flex gap-2">
                  <Textarea
                    rows={2}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Type a reply — the visitor sees it immediately."
                    aria-label="Chat reply"
                  />
                  <Button
                    className="self-end"
                    disabled={!body.trim()}
                    loading={reply.isPending}
                    onClick={() => active.session.ticket && reply.mutate(active.session.ticket.id)}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    Send
                  </Button>
                </div>
              ) : (
                <p className="text-base text-muted-foreground">
                  This chat has ended. The conversation continues on its ticket.
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-16">
              <EmptyState
                title="Pick a conversation"
                description="Queued chats are waiting for someone to pick them up."
              />
              <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                New chats appear here as they start.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
