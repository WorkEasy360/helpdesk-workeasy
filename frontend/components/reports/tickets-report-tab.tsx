'use client';

import { useQuery } from '@tanstack/react-query';
import type { AnalyticsQuery } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import { BarBreakdown, TrendChart } from './trend-chart';
import { StatTile, formatMinutes, formatPercent } from './stat-tile';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';

export function TicketsReportTab({ query }: { query: Partial<AnalyticsQuery> }) {
  const report = useQuery({
    queryKey: ['reports', 'tickets', query],
    queryFn: () => analyticsService.tickets(query),
  });

  if (report.isPending) return <LoadingState label="Loading the ticket report…" />;
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
        <StatTile label="Created" value={String(data.totals.created)} />
        <StatTile label="Resolved" value={String(data.totals.resolved)} sub={`${formatPercent(data.totals.resolutionRate)} resolution rate`} />
        <StatTile label="Reopened" value={String(data.totals.reopened)} />
        <StatTile label="Avg resolution" value={formatMinutes(data.totals.avgResolutionMinutes)} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Volume</CardTitle>
          <CardDescription>Created, resolved, closed and reopened, day by day.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart
            data={data.trend}
            series={[
              { key: 'created', label: 'Created' },
              { key: 'resolved', label: 'Resolved' },
              { key: 'closed', label: 'Closed' },
              { key: 'reopened', label: 'Reopened' },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By priority</CardTitle>
          </CardHeader>
          <CardContent>
            <BarBreakdown
              rows={data.byPriority.map((row) => ({ label: row.name, count: row.count }))}
              colourFor={(label) => data.byPriority.find((row) => row.name === label)?.colour ?? undefined}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By status</CardTitle>
          </CardHeader>
          <CardContent>
            <BarBreakdown
              rows={data.byStatus.map((row) => ({ label: row.name, count: row.count }))}
              colourFor={(label) => data.byStatus.find((row) => row.name === label)?.colour ?? undefined}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By channel</CardTitle>
          </CardHeader>
          <CardContent>
            <BarBreakdown rows={data.byChannel.map((row) => ({ label: row.channel, count: row.count }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By department</CardTitle>
          </CardHeader>
          <CardContent>
            <BarBreakdown
              rows={data.byDepartment.map((row) => ({ label: row.name, count: row.created }))}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
