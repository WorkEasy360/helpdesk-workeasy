'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Phone, CalendarDays, ClipboardList, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { activitiesService } from '@/services/activities.service';
import { useAuthStore } from '@/stores/auth.store';
import { cn, formatDateTime } from '@/lib/utils';
import type { Activity } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';

const ICONS = { TASK: ClipboardList, CALL: Phone, EVENT: CalendarDays } as const;

export function ActivityList({ activities, showTicket = true }: { activities: Activity[]; showTicket?: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);

  const refresh = async (activity: Activity) => {
    await queryClient.invalidateQueries({ queryKey: ['activities'] });
    if (activity.ticket) await queryClient.invalidateQueries({ queryKey: ['ticket', activity.ticket.id] });
  };
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Activity['status'] }) => activitiesService.update(id, { status }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update.'),
  });
  const remove = useMutation({
    mutationFn: (activity: Activity) => activitiesService.remove(activity.id).then(() => activity),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  return (
    <ul className="divide-y divide-border">
      {activities.map((activity) => {
        const Icon = ICONS[activity.type];
        const overdue = activity.status === 'OPEN' && activity.dueAt && new Date(activity.dueAt) < new Date();
        const when = activity.type === 'EVENT' ? activity.startAt : activity.dueAt ?? activity.completedAt ?? activity.createdAt;
        return (
          <li key={activity.id} className="flex items-start gap-3 px-3 py-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', activity.status !== 'OPEN' && 'text-muted-foreground line-through')}>{activity.subject}</p>
              <p className="text-xs text-muted-foreground">
                {activity.type === 'CALL' && activity.callDirection ? `${activity.callDirection.toLowerCase()} · ` : ''}
                {activity.type === 'CALL' && activity.callDurationSeconds != null ? `${Math.round(activity.callDurationSeconds / 60)} min · ` : ''}
                {formatDateTime(when)}
                {activity.assignedTo ? ` · ${activity.assignedTo.firstName} ${activity.assignedTo.lastName}` : ''}
                {showTicket && activity.ticket ? (
                  <>
                    {' · '}
                    <Link href={`/tickets/${activity.ticket.id}`} className="hover:underline">#{activity.ticket.ticketNumber}</Link>
                  </>
                ) : null}
              </p>
              {activity.description ? <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{activity.description}</p> : null}
            </div>
            {overdue ? <Badge variant="danger">Overdue</Badge> : activity.status !== 'OPEN' ? <Badge>{activity.status.toLowerCase()}</Badge> : null}
            {can(PERMISSIONS.ACTIVITY_UPDATE) ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={activity.status === 'OPEN' ? 'Mark complete' : 'Reopen'}
                onClick={() => setStatus.mutate({ id: activity.id, status: activity.status === 'OPEN' ? 'COMPLETED' : 'OPEN' })}
              >
                {activity.status === 'OPEN' ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
              </Button>
            ) : null}
            {can(PERMISSIONS.ACTIVITY_DELETE) ? (
              <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void confirm({ title: 'Delete this activity?', confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(activity) })}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
