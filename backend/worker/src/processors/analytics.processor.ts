import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  expireSurveys,
  renderReportCsv,
  rollupRecent,
  type AnalyticsDeps,
} from '@digisoft/analytics';
import { analyticsQuerySchema, type ReportKind } from '@digisoft/shared';
import type { StorageProvider } from '@digisoft/storage';

export interface ReportExportJob {
  organizationId: string;
  exportId: string;
}

export interface AnalyticsProcessorDeps extends AnalyticsDeps {
  logger: Logger;
  storage: StorageProvider;
  rollupDays: number;
}

/**
 * Class C (retention and system maintenance - never gated): rollups keep the organization's
 * history correct whether or not it still holds the product. The expiry of unanswered
 * surveys in the same pass is class B (cleanup).
 *
 * The nightly-ish sweep. Recent days are recomputed rather than appended to, because a
 * ticket resolved today changes the numbers for the day it was created on; surveys
 * nobody answered are expired in the same pass so the response rate stays honest.
 */
export async function handleMetricsRollup(deps: AnalyticsProcessorDeps): Promise<void> {
  const started = Date.now();
  const result = await rollupRecent(deps, deps.rollupDays);
  const expired = await expireSurveys(deps);
  deps.logger.info(
    { ...result, expiredSurveys: expired, ms: Date.now() - started },
    'Metric rollup complete',
  );
}

/**
 * Renders one export to CSV and writes it to the same storage attachments use.
 *
 * Class B (allowed after access ends - never gated): finishing an export the customer already
 * asked for. A request made after access ended is refused at the API, not here.
 */
export async function handleReportExport(
  job: Job<ReportExportJob>,
  deps: AnalyticsProcessorDeps,
): Promise<void> {
  const { organizationId, exportId } = job.data;
  const record = await deps.prisma.reportExport.findFirst({
    where: { id: exportId, organizationId },
    select: { id: true, kind: true, filters: true, status: true },
  });
  if (!record) {
    deps.logger.warn({ exportId }, 'Export row is gone; nothing to render');
    return;
  }
  if (record.status === 'READY') return;

  try {
    const filters = analyticsQuerySchema.parse(record.filters ?? {});
    const { csv, rowCount } = await renderReportCsv(
      deps,
      organizationId,
      record.kind as ReportKind,
      filters,
    );

    const body = Buffer.from(csv, 'utf8');
    const fileName = `${record.kind.toLowerCase()}-report-${new Date().toISOString().slice(0, 10)}.csv`;
    const stored = await deps.storage.put(
      `exports/${organizationId}/${exportId}.csv`,
      body,
      'text/csv',
    );

    await deps.prisma.reportExport.update({
      where: { id: exportId },
      data: {
        status: 'READY',
        storageKey: stored.storageKey,
        fileName,
        rowCount,
        sizeBytes: stored.size,
        completedAt: new Date(),
        error: null,
      },
    });
    deps.logger.info({ exportId, rowCount, bytes: stored.size }, 'Export ready');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.prisma.reportExport.update({
      where: { id: exportId },
      data: { status: 'FAILED', error: message.slice(0, 500), completedAt: new Date() },
    });
    // Recorded on the row, then rethrown so BullMQ's retry still applies.
    throw error;
  }
}
