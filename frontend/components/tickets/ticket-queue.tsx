'use client';

import Link from 'next/link';
import type { PageMeta } from '@digisoft/shared';
import { cn, formatDateTime } from '@/lib/utils';
import type { TicketSummary } from '@/types/api';
import { PriorityBadge, SlaBadge, StatusBadge, TagChip } from './ticket-badges';

/** Compact list used as the left pane of the workspace. */
export function TicketQueueList({
  tickets,
  activeId,
  meta,
}: {
  tickets: TicketSummary[];
  activeId?: string;
  meta?: PageMeta;
}) {
  return (
    <ul className="divide-y divide-border">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <Link
            href={`/tickets/${ticket.id}`}
            aria-current={ticket.id === activeId ? 'true' : undefined}
            className={cn(
              'block px-3 py-2.5 transition-colors hover:bg-surface-muted',
              ticket.id === activeId && 'bg-muted',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">#{ticket.ticketNumber}</span>
              <PriorityBadge priority={ticket.priority} />
              <span className="ml-auto text-xs text-muted-foreground">
                {formatDateTime(ticket.updatedAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-base font-medium">{ticket.subject}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={ticket.status} />
              <SlaBadge ticket={ticket} />
              <span className="truncate text-xs text-muted-foreground">
                {ticket.contact
                  ? `${ticket.contact.firstName} ${ticket.contact.lastName ?? ''}`.trim()
                  : 'No contact'}
              </span>
              {ticket.tags.slice(0, 2).map((entry) => (
                <TagChip key={entry.tag.id} tag={entry.tag} />
              ))}
            </div>
          </Link>
        </li>
      ))}
      {meta && meta.total > tickets.length ? (
        <li className="px-3 py-2 text-center text-xs text-muted-foreground">
          Showing {tickets.length} of {meta.total}
        </li>
      ) : null}
    </ul>
  );
}
