'use client';

import { useQuery } from '@tanstack/react-query';
import type { AnalyticsQuery } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import { formatMinutes } from './stat-tile';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';

export function AgentsReportTab({ query }: { query: Partial<AnalyticsQuery> }) {
  const report = useQuery({
    queryKey: ['reports', 'agents', query],
    queryFn: () => analyticsService.agents(query),
  });

  if (report.isPending) return <LoadingState label="Loading the agent report…" />;
  if (report.isError) {
    return (
      <ErrorState
        message={report.error instanceof ApiError ? report.error.message : 'Unable to load the report.'}
        onRetry={() => report.refetch()}
      />
    );
  }

  if (report.data.rows.length === 0) {
    return <p className="text-base text-muted-foreground">No agents match this filter.</p>;
  }

  return (
    <DataTable>
      <THead>
        <TR>
          <TH>Agent</TH>
          <TH className="text-right">Assigned</TH>
          <TH className="text-right">Resolved</TH>
          <TH className="text-right">Replies</TH>
          <TH className="text-right">First responses</TH>
          <TH className="text-right">Avg first response</TH>
          <TH className="text-right">Avg resolution</TH>
          <TH className="text-right">CSAT</TH>
          <TH className="text-right">Open now</TH>
        </TR>
      </THead>
      <TBody>
        {report.data.rows.map((row) => (
          <TR key={row.agentId}>
            <TD>
              <p className="font-medium">{row.name}</p>
              <p className="text-xs text-muted-foreground">{row.email}</p>
            </TD>
            <TD className="text-right tabular-nums">{row.assigned}</TD>
            <TD className="text-right tabular-nums">{row.resolved}</TD>
            <TD className="text-right tabular-nums">{row.publicReplies}</TD>
            <TD className="text-right tabular-nums">{row.firstResponses}</TD>
            <TD className="text-right tabular-nums">{formatMinutes(row.avgFirstResponseMinutes)}</TD>
            <TD className="text-right tabular-nums">{formatMinutes(row.avgResolutionMinutes)}</TD>
            <TD className="text-right tabular-nums">
              {row.csatAverage !== null ? `${row.csatAverage.toFixed(1)} (${row.csatResponses})` : '—'}
            </TD>
            <TD className="text-right tabular-nums">{row.openNow}</TD>
          </TR>
        ))}
      </TBody>
    </DataTable>
  );
}
