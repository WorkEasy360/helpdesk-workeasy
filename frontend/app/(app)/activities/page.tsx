'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { activitiesService } from '@/services/activities.service';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/layout/page-header';
import { ActivityFormDialog } from '@/components/activities/activity-form-dialog';
import { ActivityList } from '@/components/activities/activity-list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

type View = 'mine' | 'open' | 'overdue' | 'all';
type Kind = 'ALL' | 'TASK' | 'CALL' | 'EVENT';

export default function ActivitiesPage() {
  const can = useAuthStore((state) => state.can);
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<Kind>('ALL');
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);

  const params = useMemo(
    () => ({
      page,
      pageSize: 25,
      ...(kind !== 'ALL' ? { type: kind } : {}),
      ...(view === 'mine' ? { assignedToMe: true, status: 'OPEN' as const } : {}),
      ...(view === 'open' ? { status: 'OPEN' as const } : {}),
      ...(view === 'overdue' ? { overdue: true } : {}),
      sort: 'dueAt',
      order: 'asc' as const,
    }),
    [page, view, kind],
  );
  const activities = useQuery({ queryKey: ['activities', params], queryFn: () => activitiesService.list(params) });

  return (
    <>
      <PageHeader
        title="Activities"
        description="Tasks, calls and events tied to your support work."
        actions={can(PERMISSIONS.ACTIVITY_CREATE) ? <Button onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4" aria-hidden />New activity</Button> : null}
      />
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Views" className="c-segmented">
          {(['open', 'mine', 'overdue', 'all'] as View[]).map((item) => (
            <button key={item} type="button" aria-pressed={view === item} onClick={() => { setView(item); setPage(1); }}>
              {item === 'mine' ? 'Assigned to me' : item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        <nav aria-label="Type" className="c-segmented ml-auto">
          {(['ALL', 'TASK', 'CALL', 'EVENT'] as Kind[]).map((item) => (
            <button key={item} type="button" aria-pressed={kind === item} onClick={() => { setKind(item); setPage(1); }}>
              {item === 'ALL' ? 'All types' : item.charAt(0) + item.slice(1).toLowerCase() + 's'}
            </button>
          ))}
        </nav>
      </div>

      <Card>
        {activities.isPending ? <TableSkeleton columns={3} /> : activities.isError ? (
          <ErrorState message={activities.error instanceof ApiError ? activities.error.message : 'Unable to load activities.'} onRetry={() => activities.refetch()} />
        ) : activities.data.items.length === 0 ? (
          <EmptyState title="Nothing here" description="Create a task, log a call or schedule an event." action={can(PERMISSIONS.ACTIVITY_CREATE) ? <Button onClick={() => setDialogOpen(true)}>New activity</Button> : null} />
        ) : (
          <>
            <ActivityList activities={activities.data.items} />
            <Pagination meta={activities.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>
      <ActivityFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
