'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCircle2, RotateCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { ticketConfigService, ticketsService } from '@/services/tickets.service';
import { SlaBadge } from './ticket-badges';
import { departmentsService, usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import type { TicketDetail } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { TagChip } from './ticket-badges';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  );
}

export function TicketDetailsPanel({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const can = useAuthStore((state) => state.can);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');

  const statuses = useQuery({ queryKey: ['ticket-statuses'], queryFn: ticketConfigService.statuses });
  const priorities = useQuery({
    queryKey: ['ticket-priorities'],
    queryFn: ticketConfigService.priorities,
  });
  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list });
  const agents = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => usersService.list({ page: 1, pageSize: 100, isActive: true }),
    enabled: can(PERMISSIONS.TICKET_ASSIGN),
  });
  const tags = useQuery({ queryKey: ['tags'], queryFn: ticketConfigService.tags });
  // When a blueprint governs the ticket, only its transitions are offered.
  const transitions = useQuery({
    queryKey: ['ticket', ticket.id, 'transitions'],
    queryFn: () => ticketsService.transitions(ticket.id),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] });
    await queryClient.invalidateQueries({ queryKey: ['tickets'] });
  };

  // Each control is its own mutation so a failure is reported next to the change the
  // agent actually made.
  const setStatus = useTicketMutation(
    (statusId: string) => ticketsService.changeStatus(ticket.id, { statusId }),
    'Status updated',
    refresh,
  );
  const setPriority = useTicketMutation(
    (priorityId: string) => ticketsService.changePriority(ticket.id, { priorityId }),
    'Priority updated',
    refresh,
  );
  const setAssignee = useTicketMutation(
    (assignedAgentId: string) =>
      ticketsService.assign(ticket.id, { assignedAgentId: assignedAgentId || null }),
    'Assignment updated',
    refresh,
  );
  const setDepartment = useTicketMutation(
    (departmentId: string) =>
      ticketsService.assign(ticket.id, { departmentId: departmentId || null }),
    'Department updated',
    refresh,
  );
  const setTags = useTicketMutation(
    (tagIds: string[]) => ticketsService.setTags(ticket.id, tagIds),
    'Tags updated',
    refresh,
  );
  const toggleFollow = useTicketMutation(
    (isFollowing: boolean) =>
      isFollowing ? ticketsService.unfollow(ticket.id) : ticketsService.follow(ticket.id),
    'Updated',
    refresh,
  );
  const closeTicket = useTicketMutation(
    (_: void) => ticketsService.close(ticket.id),
    'Ticket closed',
    refresh,
  );
  const reopenTicket = useTicketMutation(
    (_: void) => ticketsService.reopen(ticket.id),
    'Ticket reopened',
    refresh,
  );

  const resolve = useMutation({
    mutationFn: () => ticketsService.resolve(ticket.id, { resolutionNote }),
    onSuccess: async () => {
      setResolveOpen(false);
      setResolutionNote('');
      await refresh();
      toast.success('Ticket resolved');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to resolve the ticket.'),
  });

  const canUpdate = can(PERMISSIONS.TICKET_UPDATE);
  const canAssign = can(PERMISSIONS.TICKET_ASSIGN);
  const following = ticket.followers.some((follower) => follower.userId === user?.id);
  const selectedTagIds = ticket.tags.map((entry) => entry.tag.id);

  return (
    <div className="space-y-4 p-4">
      <section aria-label="Quick actions" className="flex flex-wrap gap-2">
        {canUpdate && !ticket.status.isResolved ? (
          <Button size="sm" onClick={() => setResolveOpen(true)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Resolve
          </Button>
        ) : null}
        {canUpdate && ticket.status.isResolved && !ticket.status.isClosed ? (
          <Button size="sm" variant="outline" onClick={() => closeTicket.mutate()}>
            <XCircle className="h-4 w-4" aria-hidden />
            Close
          </Button>
        ) : null}
        {canUpdate && (ticket.status.isResolved || ticket.status.isClosed) ? (
          <Button size="sm" variant="outline" onClick={() => reopenTicket.mutate()}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            Reopen
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => toggleFollow.mutate(following)}>
          {following ? (
            <>
              <BellOff className="h-4 w-4" aria-hidden />
              Unfollow
            </>
          ) : (
            <>
              <Bell className="h-4 w-4" aria-hidden />
              Follow
            </>
          )}
        </Button>
      </section>

      <section aria-label="Ticket properties">
        <dl className="divide-y divide-border">
          <Row label="Status">
            <Select
              aria-label="Status"
              value={ticket.status.id}
              disabled={!canUpdate}
              onChange={(event) => setStatus.mutate(event.target.value)}
            >
              <option value={ticket.status.id}>{ticket.status.name}</option>
              {transitions.data?.governed
                ? transitions.data.transitions.map((transition) => {
                    const target = statuses.data?.find((status) => status.id === transition.toStatusId);
                    return (
                      <option key={transition.transitionId} value={transition.toStatusId}>
                        {transition.name} → {target?.name ?? '…'}
                        {transition.requiredFields.length > 0 ? ' *' : ''}
                      </option>
                    );
                  })
                : statuses.data
                    ?.filter((status) => status.id !== ticket.status.id)
                    .map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
            </Select>
            {transitions.data?.governed ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Workflow: {transitions.data.blueprint?.name}. * needs fields first.
              </p>
            ) : null}
          </Row>
          <Row label="Priority">
            <Select
              aria-label="Priority"
              value={ticket.priority.id}
              disabled={!canUpdate}
              onChange={(event) => setPriority.mutate(event.target.value)}
            >
              {priorities.data?.map((priority) => (
                <option key={priority.id} value={priority.id}>
                  {priority.name}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Assignee">
            <Select
              aria-label="Assignee"
              value={ticket.assignedAgent?.id ?? ''}
              disabled={!canAssign}
              onChange={(event) => setAssignee.mutate(event.target.value)}
            >
              <option value="">Unassigned</option>
              {agents.data?.items.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.firstName} {agent.lastName}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Department">
            <Select
              aria-label="Department"
              value={ticket.department?.id ?? ''}
              disabled={!canAssign}
              onChange={(event) => setDepartment.mutate(event.target.value)}
            >
              <option value="">None</option>
              {departments.data?.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Category">{ticket.category?.name ?? '—'}</Row>
          <Row label="Source">{ticket.source.toLowerCase().replace('_', ' ')}</Row>
          <Row label="Created">{formatDateTime(ticket.createdAt)}</Row>
          <Row label="First reply">{formatDateTime(ticket.firstResponseAt)}</Row>
          <Row label="Resolved">{formatDateTime(ticket.resolvedAt)}</Row>
        </dl>
      </section>

      <section aria-label="SLA" className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SLA</h3>
        {ticket.slaPolicy ? (
          <dl className="space-y-1 text-base">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Policy</dt>
              <dd className="flex items-center gap-2">{ticket.slaPolicy.name}<SlaBadge ticket={ticket} /></dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">First response</dt>
              <dd className={ticket.firstResponseBreachedAt && !ticket.firstResponseAt ? 'text-error-text' : ''}>
                {ticket.firstResponseAt ? `met ${formatDateTime(ticket.firstResponseAt)}` : `due ${formatDateTime(ticket.firstResponseDueAt)}`}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Resolution</dt>
              <dd className={ticket.resolutionBreachedAt && !ticket.resolvedAt ? 'text-error-text' : ''}>
                {ticket.resolvedAt ? `met ${formatDateTime(ticket.resolvedAt)}` : `due ${formatDateTime(ticket.resolutionDueAt)}`}
              </dd>
            </div>
            {ticket.slaPausedAt ? <p className="text-xs text-muted-foreground">Clock paused since {formatDateTime(ticket.slaPausedAt)} — this status waits on someone else.</p> : null}
          </dl>
        ) : (
          <p className="text-base text-muted-foreground">No policy applies to this ticket.</p>
        )}
      </section>

      <section aria-label="Tags" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</h3>
        <div className="flex flex-wrap gap-1">
          {ticket.tags.length === 0 ? (
            <span className="text-base text-muted-foreground">None</span>
          ) : (
            ticket.tags.map((entry) => <TagChip key={entry.tag.id} tag={entry.tag} />)
          )}
        </div>
        {canUpdate && (tags.data?.length ?? 0) > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tags.data?.map((tag) => {
              const selected = selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setTags.mutate(
                      selected
                        ? selectedTagIds.filter((id) => id !== tag.id)
                        : [...selectedTagIds, tag.id],
                    )
                  }
                  className={`rounded border px-1.5 py-0.5 text-xs ${
                    selected ? 'border-foreground' : 'border-border text-muted-foreground'
                  }`}
                >
                  {selected ? '− ' : '+ '}
                  {tag.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-label="Requester" className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Requester
        </h3>
        {ticket.contact ? (
          <div className="space-y-0.5 text-base">
            <Link href={`/customers/${ticket.contact.id}`} className="font-medium hover:underline">
              {ticket.contact.firstName} {ticket.contact.lastName ?? ''}
            </Link>
            {ticket.contact.isVip ? (
              <Badge variant="warning" className="ml-2">
                VIP
              </Badge>
            ) : null}
            <p className="text-muted-foreground">{ticket.contact.email ?? '—'}</p>
            {ticket.contact.account ? (
              <Link
                href={`/accounts/${ticket.contact.account.id}`}
                className="text-muted-foreground hover:underline"
              >
                {ticket.contact.account.name}
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-base text-muted-foreground">No contact linked</p>
        )}
      </section>

      {ticket.resolutionNote ? (
        <section aria-label="Resolution" className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Resolution
          </h3>
          <p className="whitespace-pre-line text-base">{ticket.resolutionNote}</p>
        </section>
      ) : null}

      {ticket.links.length > 0 ? (
        <section aria-label="Linked tickets" className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Linked tickets
          </h3>
          <ul className="space-y-1 text-base">
            {ticket.links.map((link) => (
              <li key={link.id}>
                <Link href={`/tickets/${link.linkedTicket.id}`} className="hover:underline">
                  #{link.linkedTicket.ticketNumber} · {link.linkedTicket.subject}
                </Link>
                <span className="ml-1 text-xs text-muted-foreground">
                  ({link.type.toLowerCase()})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve ticket</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="resolution-note" className="text-base font-medium">
              Resolution note
            </label>
            <Textarea
              id="resolution-note"
              rows={4}
              value={resolutionNote}
              onChange={(event) => setResolutionNote(event.target.value)}
              placeholder="What fixed it?"
            />
            <p className="text-xs text-muted-foreground">
              Required — it becomes part of the ticket record.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => resolve.mutate()}
              loading={resolve.isPending}
              disabled={resolutionNote.trim().length === 0}
            >
              Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Gives every property control the same toast-and-refresh behaviour. */
function useTicketMutation<T>(
  fn: (value: T) => Promise<unknown>,
  success: string,
  refresh: () => Promise<void>,
) {
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await refresh();
      toast.success(success);
    },
    onError: (error) => {
      const missing =
        error instanceof ApiError && Array.isArray((error.details as { missingFields?: string[] } | undefined)?.missingFields)
          ? ((error.details as { missingFields: string[] }).missingFields as string[])
          : [];
      toast.error(
        error instanceof ApiError
          ? missing.length > 0
            ? `${error.message}: ${missing.join(', ')}`
            : error.message
          : 'Unable to apply the change.',
      );
    },
  });
}
