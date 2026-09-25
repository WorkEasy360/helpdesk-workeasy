'use client';

import { Suspense, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, type ReportKind } from '@digisoft/shared';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/layout/page-header';
import { ReportFilters, toQuery, type ReportFilterValue } from '@/components/reports/report-filters';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { LoadingState } from '@/components/ui/states';
import { TicketsReportTab } from '@/components/reports/tickets-report-tab';
import { AgentsReportTab } from '@/components/reports/agents-report-tab';
import { SlaReportTab } from '@/components/reports/sla-report-tab';
import { CsatReportTab } from '@/components/reports/csat-report-tab';
import { ExportsPanel } from '@/components/reports/exports-panel';
import { SavedReports } from '@/components/reports/saved-reports';
import { Card, CardContent } from '@/components/ui/card';

type Tab = ReportKind | 'EXPORTS';

const TABS: { value: Tab; label: string }[] = [
  { value: 'TICKETS', label: 'Tickets' },
  { value: 'AGENTS', label: 'Agents' },
  { value: 'SLA', label: 'SLA' },
  { value: 'CSAT', label: 'CSAT' },
  { value: 'EXPORTS', label: 'Exports' },
];

function parseTab(value: string | null): Tab {
  const upper = value?.toUpperCase();
  return TABS.find((item) => item.value === upper)?.value ?? 'TICKETS';
}

export default function ReportsPage() {
  // useSearchParams needs a Suspense boundary to keep the route statically renderable.
  return (
    <Suspense fallback={<LoadingState />}>
      <ReportsContent />
    </Suspense>
  );
}

function ReportsContent() {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'TICKETS') params.delete('tab');
    else params.set('tab', next.toLowerCase());
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [filters, setFilters] = useState<ReportFilterValue>({ range: '30d' });

  if (!can(PERMISSIONS.REPORT_READ)) {
    return (
      <>
        <PageHeader title="Reports" description="Ticket, agent, SLA and satisfaction reporting." />
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Your role does not include report access.
          </CardContent>
        </Card>
      </>
    );
  }

  const query = toQuery(filters);

  return (
    <>
      <PageHeader title="Reports" description="Ticket, agent, SLA and satisfaction reporting." />

      <Tabs idBase="reports" label="Report sections" items={TABS} value={tab} onValueChange={setTab} />

      <TabPanel idBase="reports" value={tab} className="space-y-4">
      {tab !== 'EXPORTS' ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <ReportFilters value={filters} onChange={setFilters} />
          <SavedReports kind={tab} filters={filters} onLoad={setFilters} />
        </div>
      ) : null}

      {tab === 'TICKETS' ? <TicketsReportTab query={query} /> : null}
      {tab === 'AGENTS' ? <AgentsReportTab query={query} /> : null}
      {tab === 'SLA' ? <SlaReportTab query={query} /> : null}
      {tab === 'CSAT' ? <CsatReportTab query={query} /> : null}
      {tab === 'EXPORTS' ? (
        <ExportsPanel
          currentFilters={filters}
          onExported={() => queryClient.invalidateQueries({ queryKey: ['report-exports'] })}
        />
      ) : null}
      </TabPanel>
    </>
  );
}
