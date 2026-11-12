import type { TicketPriorityRef, TicketStatusRef } from '@/types/api';

/**
 * Status and priority colours come from the organization's own configuration, so a
 * custom workflow renders correctly without any code change here.
 */
export function StatusBadge({ status }: { status: TicketStatusRef }) {
  return (
    <span
      className="c-badge"
      style={{ borderColor: `${status.color}55`, backgroundColor: `${status.color}14`, color: status.color }}
    >
      <span className="c-dot" aria-hidden />
      {status.name}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: TicketPriorityRef }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: priority.color }}>
      <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: priority.color }} aria-hidden />
      {priority.name}
    </span>
  );
}

export function TagChip({ tag }: { tag: { name: string; color: string } }) {
  return (
    <span
      className="c-tag"
      style={{ backgroundColor: `${tag.color}1f`, color: tag.color }}
    >
      {tag.name}
    </span>
  );
}

import type { SlaFields } from '@/types/api';

/**
 * One glance at the SLA state: breached, due within the hour, paused, or on track.
 * Uses the resolution target once the first response is in, otherwise first response.
 */
export function SlaBadge({ ticket }: { ticket: SlaFields & { resolvedAt: string | null } }) {
  if (!ticket.slaPolicy || ticket.resolvedAt) return null;
  if (ticket.slaPausedAt) {
    return <span className="c-badge">SLA paused</span>;
  }
  const awaitingFirst = !ticket.firstResponseAt;
  const breached = awaitingFirst ? ticket.firstResponseBreachedAt : ticket.resolutionBreachedAt;
  const due = awaitingFirst ? ticket.firstResponseDueAt : ticket.resolutionDueAt;
  if (breached || (due && new Date(due) < new Date())) {
    return (
      <span className="c-badge" data-tone="danger">
        <span className="c-dot" aria-hidden />
        SLA breached
      </span>
    );
  }
  if (!due) return null;
  const minutes = Math.round((new Date(due).getTime() - Date.now()) / 60_000);
  if (minutes <= 60) {
    return (
      <span className="c-badge" data-tone="warning">
        <span className="c-dot" aria-hidden />
        {awaitingFirst ? 'Reply' : 'Due'} in {minutes}m
      </span>
    );
  }
  return null;
}
