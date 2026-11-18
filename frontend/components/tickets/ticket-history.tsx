'use client';

import { useQuery } from '@tanstack/react-query';
import { ticketsService } from '@/services/tickets.service';
import { formatDateTime } from '@/lib/utils';
import { ApiError } from '@/lib/api-client';
import type { TicketHistoryEntry } from '@/types/api';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

const LABELS: Record<string, string> = {
  'ticket.created': 'created the ticket',
  'ticket.updated': 'updated the ticket',
  'ticket.assigned': 'changed the assignment',
  'ticket.status_changed': 'changed the status',
  'ticket.priority_changed': 'changed the priority',
  'ticket.tags_changed': 'changed the tags',
  'ticket.replied': 'replied to the customer',
  'ticket.commented': 'added an internal comment',
  'ticket.reopened': 'reopened the ticket',
  'ticket.merged': 'merged the ticket',
  'ticket.deleted': 'deleted the ticket',
  'ticket.attachment_added': 'attached a file',
  'ticket.attachment_removed': 'removed an attachment',
};

function describe(entry: TicketHistoryEntry): string {
  const label = LABELS[entry.action] ?? entry.action;
  const from = entry.oldValue ?? {};
  const to = entry.newValue ?? {};

  for (const key of ['status', 'priority'] as const) {
    if (key in to) {
      const previous = (from as Record<string, string>)[key];
      return previous
        ? `${label}: ${previous} → ${String(to[key as keyof typeof to])}`
        : `${label}: ${String(to[key as keyof typeof to])}`;
    }
  }
  if ('fileName' in to) {
    return `${label}: ${String(to.fileName)}`;
  }
  return label;
}

export function TicketHistory({ ticketId }: { ticketId: string }) {
  const history = useQuery({
    queryKey: ['ticket', ticketId, 'history'],
    queryFn: () => ticketsService.history(ticketId),
  });

  if (history.isPending) return <LoadingState label="Loading history…" />;
  if (history.isError) {
    return (
      <ErrorState
        message={history.error instanceof ApiError ? history.error.message : 'Unable to load history.'}
        onRetry={() => history.refetch()}
      />
    );
  }
  if (history.data.items.length === 0) {
    return <EmptyState title="No history yet" />;
  }

  return (
    <ol className="space-y-3 p-4">
      {history.data.items.map((entry) => (
        <li key={entry.id} className="flex gap-3 text-base">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
          <div>
            <p>
              <span className="font-medium">
                {entry.actor ? `${entry.actor.firstName} ${entry.actor.lastName}` : 'System'}
              </span>{' '}
              {describe(entry)}
            </p>
            <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>
              {formatDateTime(entry.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
