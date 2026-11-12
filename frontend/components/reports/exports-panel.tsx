'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, RefreshCw } from 'lucide-react';
import type { ReportKind } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import type { ReportFilterValue } from './report-filters';
import { toQuery } from './report-filters';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { ApiError } from '@/lib/api-client';
import { useState } from 'react';

const KIND_LABELS: Record<ReportKind, string> = {
  TICKETS: 'Tickets',
  AGENTS: 'Agents',
  SLA: 'SLA',
  CSAT: 'CSAT',
};

function statusLabel(status: string): string {
  return status === 'QUEUED' ? 'Preparing…' : status === 'READY' ? 'Ready' : 'Failed';
}

/**
 * A CSV export is a queued job, not an instant download: this panel starts one against
 * the current filters and polls the list — a QUEUED export becomes READY within a few
 * seconds once the worker picks it up.
 */
export function ExportsPanel({
  currentFilters,
  onExported,
}: {
  currentFilters: ReportFilterValue;
  onExported: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ReportKind>('TICKETS');

  const exportsList = useQuery({
    queryKey: ['report-exports'],
    queryFn: analyticsService.listExports,
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === 'QUEUED') ? 2000 : false,
  });

  const create = useMutation({
    mutationFn: () => analyticsService.createExport({ kind, filters: toQuery(currentFilters) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['report-exports'] });
      onExported();
      toast.success('Export queued — it will be ready in a moment.');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to queue the export.'),
  });

  const download = useMutation({
    mutationFn: (row: { id: string; fileName: string | null }) =>
      analyticsService.download(row.id, row.fileName ?? `${row.id}.csv`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to download the file.'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Report
          <Select className="w-40" value={kind} onChange={(event) => setKind(event.target.value as ReportKind)}>
            {(Object.keys(KIND_LABELS) as ReportKind[]).map((key) => (
              <option key={key} value={key}>
                {KIND_LABELS[key]}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-xs text-muted-foreground">
          Uses the range and filters set on the other tabs ({currentFilters.range}).
        </p>
        <Button type="button" onClick={() => create.mutate()} loading={create.isPending}>
          Export CSV
        </Button>
      </div>

      {exportsList.isPending ? (
        <LoadingState label="Loading exports…" />
      ) : exportsList.isError ? (
        <ErrorState
          message={exportsList.error instanceof ApiError ? exportsList.error.message : 'Unable to load exports.'}
          onRetry={() => exportsList.refetch()}
        />
      ) : exportsList.data.length === 0 ? (
        <p className="text-base text-muted-foreground">No exports yet.</p>
      ) : (
        <DataTable>
          <THead>
            <TR>
              <TH>Report</TH>
              <TH>Status</TH>
              <TH className="text-right">Rows</TH>
              <TH>Requested</TH>
              <TH>Requested by</TH>
              <TH className="text-right">File</TH>
            </TR>
          </THead>
          <TBody>
            {exportsList.data.map((row) => (
              <TR key={row.id}>
                <TD>{KIND_LABELS[row.kind]}</TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    {row.status === 'QUEUED' ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
                    ) : null}
                    {statusLabel(row.status)}
                  </span>
                  {row.status === 'FAILED' && row.error ? (
                    <p className="text-xs text-destructive">{row.error}</p>
                  ) : null}
                </TD>
                <TD className="text-right tabular-nums">{row.rowCount}</TD>
                <TD className="text-xs text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString()}
                </TD>
                <TD className="text-xs text-muted-foreground">
                  {row.requestedBy ? `${row.requestedBy.firstName} ${row.requestedBy.lastName}` : '—'}
                </TD>
                <TD className="text-right">
                  {row.status === 'READY' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={download.isPending && download.variables?.id === row.id}
                      onClick={() => download.mutate(row)}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      Download
                    </Button>
                  ) : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </DataTable>
      )}
    </div>
  );
}
