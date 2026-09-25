'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  BULK_TICKET_LIMIT,
  PERMISSIONS,
  TICKET_STATUS_CATEGORIES,
  type BulkUpdateTicketsInput,
  type BulkUpdateTicketsResponse,
  type TicketStatusCategory,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { ticketConfigService, ticketsService } from '@/services/tickets.service';
import { usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { NewTicketDialog } from '@/components/tickets/new-ticket-dialog';
import { PriorityBadge, SlaBadge, StatusBadge, TagChip } from '@/components/tickets/ticket-badges';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, LoadingState, TableSkeleton } from '@/components/ui/states';

type View = 'all' | 'open' | 'mine' | 'unassigned';

const VIEWS: { key: View; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'all', label: 'All' },
];

/** Must stay within the API's whitelist of sortable ticket fields. */
const SORTS = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'dueAt:asc', label: 'Due soonest' },
  { value: 'ticketNumber:desc', label: 'Ticket number' },
  { value: 'subject:asc', label: 'Subject A–Z' },
] as const;
type SortField = 'updatedAt' | 'createdAt' | 'dueAt' | 'ticketNumber' | 'subject';
const SORT_FIELDS: readonly SortField[] = [
  'updatedAt',
  'createdAt',
  'dueAt',
  'ticketNumber',
  'subject',
];

const DEFAULT_VIEW: View = 'open';
const DEFAULT_SORT = 'updatedAt:desc';

function parseView(value: string | null): View {
  return VIEWS.some((view) => view.key === value) ? (value as View) : DEFAULT_VIEW;
}

function parseSort(
  sort: string | null,
  order: string | null,
): { sort: SortField; order: 'asc' | 'desc' } {
  const field = SORT_FIELDS.includes(sort as SortField) ? (sort as SortField) : 'updatedAt';
  return { sort: field, order: order === 'asc' ? 'asc' : 'desc' };
}

/** A bulk request minus the ticket ids, kept as a union so each action keeps its payload. */
type BulkRequest = BulkUpdateTicketsInput extends infer Input
  ? Input extends BulkUpdateTicketsInput
    ? Omit<Input, 'ticketIds'>
    : never
  : never;

const STATUS_CATEGORY_LABELS: Record<TicketStatusCategory, string> = {
  open: 'Open',
  resolved: 'Resolved',
  closed: 'Closed',
};

function parseStatusCategory(value: string | null): TicketStatusCategory | '' {
  return TICKET_STATUS_CATEGORIES.includes(value as TicketStatusCategory)
    ? (value as TicketStatusCategory)
    : '';
}

/** Only a calendar date is kept in the URL; the API reads it as a whole UTC day. */
function parseDate(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

/** The first few failure reasons, with the ticket numbers they hit, for the result toast. */
function describeFailures(
  results: BulkUpdateTicketsResponse['results'],
  ticketNumbers: Map<string, number>,
  limit = 3,
): string {
  const failures = results.filter((result) => !result.ok);
  const lines = failures.slice(0, limit).map((result) => {
    const number = ticketNumbers.get(result.id);
    return `${number !== undefined ? `#${number}` : 'Ticket'}: ${result.error?.message ?? 'Failed'}`;
  });
  if (failures.length > limit) lines.push(`…and ${failures.length - limit} more`);
  return lines.join('\n');
}

export default function TicketsPage() {
  // useSearchParams needs a Suspense boundary in Next 15.
  return (
    <Suspense fallback={<LoadingState />}>
      <TicketsView />
    </Suspense>
  );
}

function TicketsView() {
  const can = useAuthStore((state) => state.can);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // The URL is the single source of truth for the list, so views can be bookmarked,
  // shared, linked to from the dashboard and restored with the back button.
  const view = parseView(searchParams.get('view'));
  const query = searchParams.get('q') ?? '';
  const statusId = searchParams.get('statusId') ?? '';
  const priorityId = searchParams.get('priorityId') ?? '';
  const statusCategory = parseStatusCategory(searchParams.get('statusCategory'));
  const createdFrom = parseDate(searchParams.get('createdFrom'));
  const createdTo = parseDate(searchParams.get('createdTo'));
  const overdue = searchParams.get('overdue') === 'true';
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const { sort, order } = parseSort(searchParams.get('sort'), searchParams.get('order'));

  const [search, setSearch] = useState(query);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');

  // Keep the box in step when the URL changes underneath it (back/forward, a link).
  useEffect(() => setSearch(query), [query]);

  const updateParams = useCallback(
    (updates: Record<string, string | number | null>, resetPage = true) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      if (resetPage && !('page' in updates)) next.delete('page');
      if (next.get('page') === '1') next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const statuses = useQuery({
    queryKey: ['ticket-statuses'],
    queryFn: ticketConfigService.statuses,
  });
  const priorities = useQuery({
    queryKey: ['ticket-priorities'],
    queryFn: ticketConfigService.priorities,
  });
  const summary = useQuery({ queryKey: ['tickets', 'summary'], queryFn: ticketsService.summary });

  const params = useMemo(
    () => ({
      page,
      pageSize: 25,
      q: query || undefined,
      statusId: statusId || undefined,
      priorityId: priorityId || undefined,
      statusCategory: statusCategory || undefined,
      createdFrom: createdFrom || undefined,
      createdTo: createdTo || undefined,
      ...(overdue ? { overdue: true } : {}),
      ...(view === 'open' ? { open: true } : {}),
      ...(view === 'mine' ? { assignedToMe: true } : {}),
      ...(view === 'unassigned' ? { unassigned: true, open: true } : {}),
      sort,
      order,
    }),
    [
      page,
      query,
      statusId,
      priorityId,
      statusCategory,
      createdFrom,
      createdTo,
      overdue,
      view,
      sort,
      order,
    ],
  );

  const tickets = useQuery({
    queryKey: ['tickets', params],
    queryFn: () => ticketsService.list(params),
  });

  // A selection only ever covers the page on screen.
  const paramsKey = JSON.stringify(params);
  useEffect(() => setSelected(new Set()), [paramsKey]);

  // POST /tickets/bulk needs ticket.update; assigning through it also needs ticket.assign.
  const canUpdate = can(PERMISSIONS.TICKET_UPDATE);
  const canAssign = canUpdate && can(PERMISSIONS.TICKET_ASSIGN);
  const canBulk = canUpdate;

  const agents = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => usersService.list({ page: 1, pageSize: 100, isActive: true }),
    enabled: canAssign && selected.size > 0,
  });

  const counts: Record<View, number | undefined> = {
    all: summary.data?.total,
    open: summary.data?.open,
    mine: summary.data?.assignedToMe,
    unassigned: summary.data?.unassigned,
  };

  const pageIds = tickets.data?.items.map((ticket) => ticket.id) ?? [];
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const ticketNumbers = useMemo(
    () => new Map(tickets.data?.items.map((ticket) => [ticket.id, ticket.ticketNumber]) ?? []),
    [tickets.data],
  );

  /** One request for the whole selection; each ticket succeeds or fails on its own. */
  const bulk = async (label: string, request: BulkRequest): Promise<boolean> => {
    const ticketIds = [...selected].slice(0, BULK_TICKET_LIMIT);
    if (ticketIds.length === 0) return false;
    setBulkBusy(true);
    try {
      const result = await ticketsService.bulk({ ...request, ticketIds } as BulkUpdateTicketsInput);
      const updated = `${result.succeeded} ticket${result.succeeded === 1 ? '' : 's'} updated`;
      if (result.failed === 0) {
        toast.success(`${label}: ${updated}`);
      } else {
        const message = `${label}: ${updated}, ${result.failed} failed`;
        const description = describeFailures(result.results, ticketNumbers);
        if (result.succeeded === 0) toast.error(message, { description });
        else toast.warning(message, { description });
      }
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
      return true;
    } catch (error) {
      toast.error(
        error instanceof ApiError ? `${label} failed: ${error.message}` : `${label} failed.`,
      );
      return false;
    } finally {
      setBulkBusy(false);
    }
  };

  const submitResolve = async () => {
    const note = resolutionNote.trim();
    if (!note) return;
    const done = await bulk('Resolved', { action: 'resolve', payload: { resolutionNote: note } });
    if (done) {
      setResolveOpen(false);
      setResolutionNote('');
    }
  };

  const hasFilters = Boolean(
    query || statusId || priorityId || statusCategory || createdFrom || createdTo || overdue,
  );
  const clearFilters = () => {
    setSearch('');
    updateParams({
      q: null,
      statusId: null,
      priorityId: null,
      statusCategory: null,
      createdFrom: null,
      createdTo: null,
      overdue: null,
    });
  };

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Every request your team is working on."
        actions={
          can(PERMISSIONS.TICKET_CREATE) ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              New ticket
            </Button>
          ) : null
        }
      />

      <nav aria-label="Saved views" className="flex flex-wrap gap-1">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={view === item.key}
            onClick={() => updateParams({ view: item.key === DEFAULT_VIEW ? null : item.key })}
            className={`rounded-md px-3 py-1.5 text-sm ${
              view === item.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item.label}
            {counts[item.key] !== undefined ? (
              <span className="ml-1.5 tabular-nums opacity-70">{counts[item.key]}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          updateParams({ q: search.trim() || null });
        }}
      >
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="ticket-search" className="sr-only">
            Search tickets
          </label>
          <Input
            id="ticket-search"
            placeholder="Search by subject, description or #number"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="filter-status" className="sr-only">
            Filter by status
          </label>
          <Select
            id="filter-status"
            value={statusId}
            onChange={(event) => updateParams({ statusId: event.target.value || null })}
          >
            <option value="">All statuses</option>
            {statuses.data?.map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="filter-priority" className="sr-only">
            Filter by priority
          </label>
          <Select
            id="filter-priority"
            value={priorityId}
            onChange={(event) => updateParams({ priorityId: event.target.value || null })}
          >
            <option value="">All priorities</option>
            {priorities.data?.map((priority) => (
              <option key={priority.id} value={priority.id}>
                {priority.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="filter-status-category" className="sr-only">
            Filter by state
          </label>
          <Select
            id="filter-status-category"
            value={statusCategory}
            onChange={(event) => {
              const next = parseStatusCategory(event.target.value);
              // The Open and Unassigned views only list open tickets, so resolved or
              // closed ones can only be found across all of them.
              const leaveOpenView =
                next !== '' && next !== 'open' && (view === 'open' || view === 'unassigned');
              updateParams({
                statusCategory: next || null,
                ...(leaveOpenView ? { view: 'all' } : {}),
              });
            }}
          >
            <option value="">Any state</option>
            {TICKET_STATUS_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {STATUS_CATEGORY_LABELS[category]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Created</span>
          <Input
            type="date"
            className="w-auto"
            aria-label="Created from"
            value={createdFrom}
            max={createdTo || undefined}
            onChange={(event) =>
              updateParams({ createdFrom: parseDate(event.target.value) || null })
            }
          />
          <span className="text-xs text-muted-foreground" aria-hidden>
            –
          </span>
          <Input
            type="date"
            className="w-auto"
            aria-label="Created to"
            value={createdTo}
            min={createdFrom || undefined}
            onChange={(event) => updateParams({ createdTo: parseDate(event.target.value) || null })}
          />
        </div>
        <label className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={overdue}
            onChange={(event) => updateParams({ overdue: event.target.checked ? 'true' : null })}
          />
          Overdue
        </label>
        <div>
          <label htmlFor="ticket-sort" className="sr-only">
            Sort tickets
          </label>
          <Select
            id="ticket-sort"
            value={`${sort}:${order}`}
            onChange={(event) => {
              const [nextSort, nextOrder] = event.target.value.split(':');
              updateParams(
                event.target.value === DEFAULT_SORT
                  ? { sort: null, order: null }
                  : { sort: nextSort ?? null, order: nextOrder ?? null },
              );
            }}
          >
            {SORTS.some((option) => option.value === `${sort}:${order}`) ? null : (
              <option value={`${sort}:${order}`}>Custom order</option>
            )}
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          <Search className="h-4 w-4" aria-hidden />
          Search
        </Button>
        {hasFilters ? (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            <X className="h-4 w-4" aria-hidden />
            Clear filters
          </Button>
        ) : null}
      </form>

      {canBulk && selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
        >
          <span className="font-medium">{selected.size} selected</span>
          {canAssign ? (
            <>
              <label htmlFor="bulk-assign" className="sr-only">
                Assign selected tickets
              </label>
              <Select
                id="bulk-assign"
                className="w-auto"
                value=""
                disabled={bulkBusy || agents.isPending}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  void (value === '__none__'
                    ? bulk('Unassigned', { action: 'unassign', payload: {} })
                    : bulk('Assigned', { action: 'assign', payload: { assignedAgentId: value } }));
                }}
              >
                <option value="">{agents.isPending ? 'Loading agents…' : 'Assign to…'}</option>
                <option value="__none__">Unassigned</option>
                {agents.data?.items.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.firstName} {agent.lastName}
                  </option>
                ))}
              </Select>
            </>
          ) : null}
          <label htmlFor="bulk-status" className="sr-only">
            Change status of selected tickets
          </label>
          <Select
            id="bulk-status"
            className="w-auto"
            value=""
            disabled={bulkBusy}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              const name = statuses.data?.find((status) => status.id === value)?.name ?? 'Status';
              void bulk(`Moved to ${name}`, { action: 'status', payload: { statusId: value } });
            }}
          >
            <option value="">Set status…</option>
            {/* Resolving needs a resolution note, so it goes through the Resolve button. */}
            {statuses.data
              ?.filter((status) => !status.isResolved)
              .map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
          </Select>
          <label htmlFor="bulk-priority" className="sr-only">
            Change priority of selected tickets
          </label>
          <Select
            id="bulk-priority"
            className="w-auto"
            value=""
            disabled={bulkBusy}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              const name =
                priorities.data?.find((priority) => priority.id === value)?.name ?? 'Priority';
              void bulk(`Priority set to ${name}`, {
                action: 'priority',
                payload: { priorityId: value },
              });
            }}
          >
            <option value="">Set priority…</option>
            {priorities.data?.map((priority) => (
              <option key={priority.id} value={priority.id}>
                {priority.name}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => setResolveOpen(true)}
          >
            Resolve
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => void bulk('Closed', { action: 'close', payload: {} })}
          >
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => void bulk('Reopened', { action: 'reopen', payload: {} })}
          >
            Reopen
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={bulkBusy}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      ) : null}

      <Card>
        {tickets.isPending ? (
          <TableSkeleton columns={6} />
        ) : tickets.isError ? (
          <ErrorState
            message={
              tickets.error instanceof ApiError ? tickets.error.message : 'Unable to load tickets.'
            }
            onRetry={() => tickets.refetch()}
          />
        ) : tickets.data.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No tickets match these filters' : 'No tickets in this view'}
            description={
              hasFilters
                ? 'Try a different search, status, priority or date range.'
                : 'Raise the first ticket for a customer.'
            }
            action={
              hasFilters ? (
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : can(PERMISSIONS.TICKET_CREATE) ? (
                <Button onClick={() => setDialogOpen(true)}>New ticket</Button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  {canBulk ? (
                    <TH className="w-8">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        aria-label="Select all tickets on this page"
                        checked={allSelected}
                        onChange={(event) =>
                          setSelected(event.target.checked ? new Set(pageIds) : new Set())
                        }
                      />
                    </TH>
                  ) : null}
                  <TH>#</TH>
                  <TH>Subject</TH>
                  <TH>Requester</TH>
                  <TH>Status</TH>
                  <TH>Priority</TH>
                  <TH>Assignee</TH>
                  <TH>Updated</TH>
                </TR>
              </THead>
              <TBody>
                {tickets.data.items.map((ticket) => (
                  <TR key={ticket.id}>
                    {canBulk ? (
                      <TD>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input"
                          aria-label={`Select ticket ${ticket.ticketNumber}`}
                          checked={selected.has(ticket.id)}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(ticket.id);
                              else next.delete(ticket.id);
                              return next;
                            })
                          }
                        />
                      </TD>
                    ) : null}
                    <TD className="tabular-nums text-muted-foreground">{ticket.ticketNumber}</TD>
                    <TD>
                      <Link href={`/tickets/${ticket.id}`} className="font-medium hover:underline">
                        {ticket.subject}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {ticket.tags.map((entry) => (
                          <TagChip key={entry.tag.id} tag={entry.tag} />
                        ))}
                      </div>
                    </TD>
                    <TD className="text-muted-foreground">
                      {ticket.contact
                        ? `${ticket.contact.firstName} ${ticket.contact.lastName ?? ''}`.trim()
                        : '—'}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={ticket.status} />
                        <SlaBadge ticket={ticket} />
                      </div>
                    </TD>
                    <TD>
                      <PriorityBadge priority={ticket.priority} />
                    </TD>
                    <TD className="text-muted-foreground">
                      {ticket.assignedAgent
                        ? `${ticket.assignedAgent.firstName} ${ticket.assignedAgent.lastName}`
                        : 'Unassigned'}
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(ticket.updatedAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
            <Pagination
              meta={tickets.data.meta}
              onPageChange={(next) => updateParams({ page: next }, false)}
            />
          </>
        )}
      </Card>

      <NewTicketDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      <Dialog
        open={resolveOpen}
        onOpenChange={(open) => {
          if (!bulkBusy) setResolveOpen(open);
        }}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitResolve();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                Resolve {selected.size} ticket{selected.size === 1 ? '' : 's'}
              </DialogTitle>
              <DialogDescription>
                The same resolution note is recorded on every selected ticket.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <label htmlFor="bulk-resolution-note" className="text-sm font-medium">
                Resolution note
              </label>
              <Textarea
                id="bulk-resolution-note"
                required
                maxLength={5000}
                value={resolutionNote}
                placeholder="What fixed it?"
                onChange={(event) => setResolutionNote(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={bulkBusy}
                onClick={() => setResolveOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={bulkBusy} disabled={!resolutionNote.trim()}>
                Resolve
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
