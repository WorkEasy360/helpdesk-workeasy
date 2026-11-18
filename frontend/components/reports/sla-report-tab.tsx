'use client';

import { useQuery } from '@tanstack/react-query';
import type { AnalyticsQuery } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import { TrendChart } from './trend-chart';
import { StatTile, formatPercent } from './stat-tile';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';

export function SlaReportTab({ query }: { query: Partial<AnalyticsQuery> }) {
  const report = useQuery({
    queryKey: ['reports', 'sla', query],
    queryFn: () => analyticsService.sla(query),
  });

  if (report.isPending) return <LoadingState label="Loading the SLA report…" />;
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
          label="First response compliance"
          value={formatPercent(data.totals.firstResponseCompliance)}
          sub={`${data.totals.firstResponseMet} of ${data.totals.firstResponses}`}
        />
        <StatTile
          label="Resolution compliance"
          value={formatPercent(data.totals.resolutionCompliance)}
          sub={`${data.totals.resolutionMet} of ${data.totals.resolutions}`}
        />
        <StatTile
          label="At risk"
          value={String(data.totals.atRisk)}
          sub="warned, not yet breached"
          tone={data.totals.atRisk > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Breached, still open"
          value={String(data.totals.breachedOpen)}
          tone={data.totals.breachedOpen > 0 ? 'danger' : 'default'}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Compliance over time</CardTitle>
          <CardDescription>First response and resolution, met vs. breached.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart
            data={data.trend}
            series={[
              { key: 'firstResponseMet', label: 'First response met' },
              { key: 'firstResponseBreached', label: 'First response breached' },
              { key: 'resolutionMet', label: 'Resolution met' },
              { key: 'resolutionBreached', label: 'Resolution breached' },
            ]}
          />
        </CardContent>
      </Card>

      {data.byPolicy.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>By policy</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable>
              <THead>
                <TR>
                  <TH>Policy</TH>
                  <TH className="text-right">Tickets</TH>
                  <TH className="text-right">First response breached</TH>
                  <TH className="text-right">Resolution breached</TH>
                </TR>
              </THead>
              <TBody>
                {data.byPolicy.map((policy) => (
                  <TR key={policy.id}>
                    <TD>{policy.name}</TD>
                    <TD className="text-right tabular-nums">{policy.tickets}</TD>
                    <TD className="text-right tabular-nums">{policy.firstResponseBreached}</TD>
                    <TD className="text-right tabular-nums">{policy.resolutionBreached}</TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
