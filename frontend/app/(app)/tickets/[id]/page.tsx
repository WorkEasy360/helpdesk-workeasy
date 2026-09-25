'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { ticketsService } from '@/services/tickets.service';
import { cn } from '@/lib/utils';
import { TicketQueueList } from '@/components/tickets/ticket-queue';
import { TicketConversation } from '@/components/tickets/ticket-conversation';
import { TicketComposer } from '@/components/tickets/ticket-composer';
import { TicketDetailsPanel } from '@/components/tickets/ticket-details-panel';
import { TicketHistory } from '@/components/tickets/ticket-history';
import { TicketActivities } from '@/components/tickets/ticket-activities';
import { TicketAiPanel } from '@/components/tickets/ticket-ai-panel';
import { StatusBadge, PriorityBadge } from '@/components/tickets/ticket-badges';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Tabs, TabPanel } from '@/components/ui/tabs';

type Tab = 'conversation' | 'assistant' | 'activities' | 'history';

const TABS: { value: Tab; label: string }[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'activities', label: 'Activities' },
  { value: 'history', label: 'History' },
];

/**
 * Three-pane agent workspace: queue on the left, conversation in the middle, ticket
 * properties on the right. Below `lg` the side panes collapse so the conversation
 * always has room.
 */
export default function TicketWorkspacePage() {
  const params = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('conversation');
  const [detailsOpen, setDetailsOpen] = useState(true);

  const queue = useQuery({
    queryKey: ['tickets', { pane: 'queue' }],
    queryFn: () =>
      ticketsService.list({ page: 1, pageSize: 40, open: true, sort: 'updatedAt', order: 'desc' }),
  });

  const ticket = useQuery({
    queryKey: ['ticket', params.id],
    queryFn: () => ticketsService.get(params.id),
  });

  if (ticket.isPending) {
    return <LoadingState label="Loading ticket…" />;
  }
  if (ticket.isError) {
    const notFound = ticket.error instanceof ApiError && ticket.error.status === 404;
    return (
      <ErrorState
        message={
          notFound
            ? 'This ticket does not exist, or your role does not give you access to it.'
            : 'Unable to load the ticket.'
        }
        onRetry={notFound ? undefined : () => ticket.refetch()}
      />
    );
  }

  const data = ticket.data;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] lg:-m-6">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border xl:flex">
        <div className="border-b border-border px-3 py-2">
          <Link href="/tickets" className="text-sm font-medium hover:underline">
            Open tickets
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">
          {queue.isPending ? (
            <LoadingState />
          ) : queue.isError ? (
            <ErrorState message="Unable to load the queue." onRetry={() => queue.refetch()} />
          ) : (
            <TicketQueueList
              tickets={queue.data.items}
              activeId={data.id}
              meta={queue.data.meta}
            />
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-2">
            <Button variant="ghost" size="icon" asChild className="xl:hidden">
              <Link href="/tickets" aria-label="Back to tickets">
                <ArrowLeft className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Ticket #{data.ticketNumber}</p>
              <h1 className="truncate text-base font-semibold">{data.subject}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge status={data.status} />
                <PriorityBadge priority={data.priority} />
                {data.department ? (
                  <span className="text-xs text-muted-foreground">{data.department.name}</span>
                ) : null}
                {data.mergedIntoTicketId ? (
                  <Link
                    href={`/tickets/${data.mergedIntoTicketId}`}
                    className="text-xs text-muted-foreground underline"
                  >
                    Merged into another ticket
                  </Link>
                ) : null}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-label={detailsOpen ? 'Hide ticket details' : 'Show ticket details'}
            >
              {detailsOpen ? (
                <PanelRightClose className="h-4 w-4" aria-hidden />
              ) : (
                <PanelRightOpen className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>

          <Tabs
            idBase="ticket"
            label="Ticket panels"
            variant="pill"
            className="mt-2"
            items={TABS}
            value={tab}
            onValueChange={setTab}
          />
        </header>

        <TabPanel idBase="ticket" value={tab} className="flex-1 overflow-y-auto">
          {tab === 'conversation' ? (
            <TicketConversation ticket={data} />
          ) : tab === 'assistant' ? (
            <TicketAiPanel ticket={data} />
          ) : tab === 'activities' ? (
            <TicketActivities ticket={data} />
          ) : (
            <TicketHistory ticketId={data.id} />
          )}
        </TabPanel>

        {tab === 'conversation' ? <TicketComposer ticketId={data.id} /> : null}
      </section>

      <aside
        className={cn(
          'w-80 shrink-0 overflow-y-auto border-l border-border',
          detailsOpen ? 'block' : 'hidden',
          'lg:block',
        )}
      >
        <TicketDetailsPanel ticket={data} />
      </aside>
    </div>
  );
}
