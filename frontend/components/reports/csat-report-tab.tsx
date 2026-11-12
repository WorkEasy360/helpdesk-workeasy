'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { AnalyticsQuery } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import { BarBreakdown } from './trend-chart';
import { StatTile, formatPercent } from './stat-tile';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';

export function CsatReportTab({ query }: { query: Partial<AnalyticsQuery> }) {
  const report = useQuery({
    queryKey: ['reports', 'csat', query],
    queryFn: () => analyticsService.csat(query),
  });

  if (report.isPending) return <LoadingState label="Loading the CSAT report…" />;
  if (report.isError) {
    return (
      <ErrorState
        message={report.error instanceof ApiError ? report.error.message : 'Unable to load the report.'}
        onRetry={() => report.refetch()}
      />
    );
  }

  const data = report.data;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Average rating"
          value={data.totals.average !== null ? `${data.totals.average.toFixed(2)} / 5` : '—'}
        />
        <StatTile
          label="Response rate"
          value={formatPercent(data.totals.responseRate)}
          sub={`${data.totals.responses} of ${data.totals.sent} surveys`}
        />
        <StatTile
          label="Satisfaction"
          value={formatPercent(data.totals.satisfactionRate)}
          sub="ratings of 4 or 5"
        />
        <StatTile
          label="Negative"
          value={String(data.totals.negative)}
          tone={data.totals.negative > 0 ? 'danger' : 'default'}
          sub="ratings of 1 or 2"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <BarBreakdown
              rows={data.distribution.map((row) => ({ label: `${row.rating} star${row.rating === 1 ? '' : 's'}`, count: row.count }))}
            />
          </CardContent>
        </Card>
        {data.byAgent.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>By agent</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {data.byAgent.map((row) => (
                  <li key={row.agentId} className="flex items-center justify-between py-2 text-base">
                    <span>{row.name}</span>
                    <span className="text-muted-foreground">
                      {row.average !== null ? row.average.toFixed(2) : '—'} ({row.responses})
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {data.comments.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent feedback</CardTitle>
            <CardDescription>The most recent comments, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.comments.map((comment) => (
              <div key={comment.id} className="rounded-md border border-border p-3 text-base">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/tickets/${comment.ticketId}`} className="font-medium hover:underline">
                    #{comment.ticketNumber} — {comment.subject}
                  </Link>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{comment.rating} / 5</span>
                </div>
                <p className="mt-1 text-muted-foreground">{comment.comment}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {comment.contactName ?? 'Customer'} ·{' '}
                  {new Date(comment.respondedAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
