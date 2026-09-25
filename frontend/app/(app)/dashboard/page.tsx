'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@digisoft/shared';
import { accountsService } from '@/services/accounts.service';
import { contactsService } from '@/services/contacts.service';
import { departmentsService, usersService } from '@/services/settings.service';
import { analyticsService } from '@/services/analytics.service';
import { ticketsService } from '@/services/tickets.service';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/layout/page-header';
import {
  ReportFilters,
  toQuery,
  type ReportFilterValue,
} from '@/components/reports/report-filters';
import { StatTile, formatMinutes, formatPercent } from '@/components/reports/stat-tile';
import { TrendChart } from '@/components/reports/trend-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';

const DAY_MS = 86_400_000;

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The creation window the dashboard counts, as inclusive YYYY-MM-DD bounds. Mirrors
 * the API's range presets, which are whole UTC days ending today — and the ticket list
 * reads a bare date as a UTC day too, so the linked list matches the tile's count.
 */
function createdWindow(
  filters: ReportFilterValue,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = utcDate(now);
  const daysBack = (days: number) => utcDate(new Date(now.getTime() - days * DAY_MS));
  switch (filters.range) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: daysBack(6), to: today };
    case '90d':
      return { from: daysBack(89), to: today };
    case 'custom':
      return { from: (filters.from ?? today).slice(0, 10), to: (filters.to ?? today).slice(0, 10) };
    case '30d':
    default:
      return { from: daysBack(29), to: today };
  }
}

function StatCard({
  label,
  value,
  loading,
  href,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/50"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {loading ? (
        <div className="mt-2 h-7 w-16 animate-pulse rounded bg-muted" aria-hidden />
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? 0}</p>
      )}
    </Link>
  );
}

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const can = useAuthStore((state) => state.can);
  const [filters, setFilters] = useState<ReportFilterValue>({ range: '30d' });

  const contacts = useQuery({
    queryKey: ['contacts', { pageSize: 1 }],
    queryFn: () => contactsService.list({ page: 1, pageSize: 1 }),
    enabled: can(PERMISSIONS.CONTACT_READ),
  });
  const accounts = useQuery({
    queryKey: ['accounts', { pageSize: 1 }],
    queryFn: () => accountsService.list({ page: 1, pageSize: 1 }),
    enabled: can(PERMISSIONS.ACCOUNT_READ),
  });
  const users = useQuery({
    queryKey: ['users', { pageSize: 1 }],
    queryFn: () => usersService.list({ page: 1, pageSize: 1 }),
    enabled: can(PERMISSIONS.USER_READ),
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: departmentsService.list,
    enabled: can(PERMISSIONS.DEPARTMENT_READ),
  });

  const dashboard = useQuery({
    queryKey: ['dashboard', filters],
    queryFn: () => analyticsService.dashboard(toQuery(filters)),
    enabled: can(PERMISSIONS.REPORT_READ),
  });
  // Per-viewer, so it comes from the ticket queue endpoint rather than the
  // organization-wide analytics dashboard.
  const ticketSummary = useQuery({
    queryKey: ['tickets', 'summary'],
    queryFn: ticketsService.summary,
    enabled: can(PERMISSIONS.TICKET_READ),
  });

  // Deep links into the ticket list's URL state, filtered the way each tile counts.
  const created = createdWindow(filters);
  const ticketLinks = {
    // Counts tickets created in the report range.
    created: `/tickets?${new URLSearchParams({
      view: 'all',
      createdFrom: created.from,
      createdTo: created.to,
      sort: 'createdAt',
      order: 'desc',
    }).toString()}`,
    // Counts tickets resolved in the range (by resolution time). The list can only
    // filter by creation date, so this opens every ticket currently resolved.
    resolved: '/tickets?view=all&statusCategory=resolved',
    open: '/tickets?view=all&statusCategory=open',
    unassigned: '/tickets?view=unassigned',
    overdue: '/tickets?view=all&overdue=true&sort=dueAt&order=asc',
    mine: '/tickets?view=mine',
  };

  const overviewFailed = [contacts, accounts, users, departments].find((query) => query.isError);
  if (overviewFailed?.error) {
    const message =
      overviewFailed.error instanceof ApiError
        ? overviewFailed.error.message
        : 'Unable to load the dashboard.';
    return <ErrorState message={message} onRetry={() => overviewFailed.refetch()} />;
  }

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.firstName ?? ''}`.trim()}
        description="How the team and the SLA are doing, at a glance."
      />

      <section aria-label="Overview" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {can(PERMISSIONS.CONTACT_READ) ? (
          <StatCard
            label="Contacts"
            value={contacts.data?.meta.total}
            loading={contacts.isPending}
            href="/customers"
          />
        ) : null}
        {can(PERMISSIONS.ACCOUNT_READ) ? (
          <StatCard
            label="Accounts"
            value={accounts.data?.meta.total}
            loading={accounts.isPending}
            href="/accounts"
          />
        ) : null}
        {can(PERMISSIONS.USER_READ) ? (
          <StatCard
            label="Agents"
            value={users.data?.meta.total}
            loading={users.isPending}
            href="/settings/users"
          />
        ) : null}
        {can(PERMISSIONS.DEPARTMENT_READ) ? (
          <StatCard
            label="Departments"
            value={departments.data?.length}
            loading={departments.isPending}
            href="/settings/departments"
          />
        ) : null}
      </section>

      {!can(PERMISSIONS.REPORT_READ) ? null : (
        <>
          <ReportFilters value={filters} onChange={setFilters} />

          {dashboard.isPending ? (
            <LoadingState label="Loading the dashboard…" />
          ) : dashboard.isError ? (
            <ErrorState
              message={
                dashboard.error instanceof ApiError
                  ? dashboard.error.message
                  : 'Unable to load the dashboard.'
              }
              onRetry={() => dashboard.refetch()}
            />
          ) : (
            <>
              <section
                aria-label="Ticket volume"
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
              >
                <Link href={ticketLinks.created}>
                  <StatTile label="Created" value={String(dashboard.data.tickets.created)} />
                </Link>
                <Link href={ticketLinks.resolved}>
                  <StatTile label="Resolved" value={String(dashboard.data.tickets.resolved)} />
                </Link>
                <Link href={ticketLinks.open}>
                  <StatTile
                    label="Open now"
                    value={String(dashboard.data.tickets.open)}
                    sub={`${dashboard.data.tickets.unassigned} unassigned`}
                    tone={dashboard.data.tickets.unassigned > 0 ? 'warning' : 'default'}
                  />
                </Link>
                <Link href={ticketLinks.overdue}>
                  <StatTile
                    label="Overdue"
                    value={String(dashboard.data.tickets.overdue)}
                    tone={dashboard.data.tickets.overdue > 0 ? 'danger' : 'default'}
                  />
                </Link>
                {ticketSummary.data ? (
                  <Link href={ticketLinks.mine}>
                    <StatTile
                      label="Assigned to me"
                      value={String(ticketSummary.data.assignedToMe)}
                    />
                  </Link>
                ) : null}
                {ticketSummary.data ? (
                  <Link href={ticketLinks.unassigned}>
                    <StatTile
                      label="Unassigned"
                      value={String(ticketSummary.data.unassigned)}
                      tone={ticketSummary.data.unassigned > 0 ? 'warning' : 'default'}
                    />
                  </Link>
                ) : null}
              </section>

              <section
                aria-label="SLA and satisfaction"
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
              >
                <StatTile
                  label="Avg first response"
                  value={formatMinutes(dashboard.data.tickets.avgFirstResponseMinutes)}
                />
                <StatTile
                  label="Avg resolution"
                  value={formatMinutes(dashboard.data.tickets.avgResolutionMinutes)}
                />
                <StatTile
                  label="SLA compliance"
                  value={formatPercent(dashboard.data.sla.resolutionCompliance)}
                  sub={`${dashboard.data.sla.breachedOpen} open tickets already breached`}
                  tone={dashboard.data.sla.breachedOpen > 0 ? 'danger' : 'default'}
                />
                <StatTile
                  label="CSAT"
                  value={
                    dashboard.data.csat.average !== null
                      ? `${dashboard.data.csat.average.toFixed(1)} / 5`
                      : '—'
                  }
                  sub={
                    dashboard.data.csat.responses > 0
                      ? `${dashboard.data.csat.responses} responses`
                      : 'No responses yet'
                  }
                />
              </section>

              <Card>
                <CardHeader>
                  <CardTitle>Ticket volume</CardTitle>
                  <CardDescription>Created, resolved and reopened, day by day.</CardDescription>
                </CardHeader>
                <CardContent>
                  <TrendChart
                    data={dashboard.data.trend}
                    series={[
                      { key: 'created', label: 'Created', colour: '#3b82f6' },
                      { key: 'resolved', label: 'Resolved', colour: '#10b981' },
                      { key: 'reopened', label: 'Reopened', colour: '#f59e0b' },
                    ]}
                  />
                </CardContent>
              </Card>

              {dashboard.data.topAgents.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Top agents this period</CardTitle>
                    <CardDescription>By tickets resolved.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="divide-y divide-border">
                      {dashboard.data.topAgents.map((agent) => (
                        <li
                          key={agent.agentId}
                          className="flex items-center justify-between py-2 text-sm"
                        >
                          <span>{agent.name}</span>
                          <span className="text-muted-foreground">
                            {agent.resolved} resolved · {agent.publicReplies} replies
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}

              <p className="text-right text-xs text-muted-foreground">
                <Link href="/reports" className="underline hover:text-foreground">
                  Full reports and exports →
                </Link>
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
