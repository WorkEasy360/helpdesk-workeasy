'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ACTIVITY_TYPES, createActivitySchema, type ActivityFormValues, type CreateActivityInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { activitiesService } from '@/services/activities.service';
import { usersService } from '@/services/settings.service';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-links the activity to a ticket (and inherits its contact). */
  ticketId?: string;
  contactId?: string | null;
  defaultType?: (typeof ACTIVITY_TYPES)[number];
}

const LABELS: Record<(typeof ACTIVITY_TYPES)[number], string> = { TASK: 'Task', CALL: 'Call', EVENT: 'Event' };

/** `datetime-local` wants local time without a zone; the API gets ISO. */
function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ActivityFormDialog({ open, onOpenChange, ticketId, contactId, defaultType = 'TASK' }: Props) {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => usersService.list({ page: 1, pageSize: 100, isActive: true }),
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ActivityFormValues, unknown, CreateActivityInput>({ resolver: zodResolver(createActivitySchema) });
  const type = watch('type') ?? defaultType;

  useEffect(() => {
    if (open) {
      reset({ type: defaultType, subject: '', description: '', ticketId: ticketId ?? '', contactId: contactId ?? '', assignedToId: '' });
    }
  }, [open, reset, defaultType, ticketId, contactId]);

  const create = useMutation({
    mutationFn: (values: CreateActivityInput) => activitiesService.create(values),
    onSuccess: async (activity) => {
      await queryClient.invalidateQueries({ queryKey: ['activities'] });
      if (activity.ticket) await queryClient.invalidateQueries({ queryKey: ['ticket', activity.ticket.id] });
      toast.success(`${LABELS[activity.type]} saved`);
      onOpenChange(false);
    },
    onError: (error) => setError('root', { message: error instanceof ApiError ? error.message : 'Unable to save.' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {LABELS[type as keyof typeof LABELS].toLowerCase()}</DialogTitle>
          <DialogDescription>Tasks, calls and events stay attached to the ticket or customer they concern.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => create.mutateAsync(values))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field label="Type" htmlFor="type" error={errors.type?.message} required>
              <Select {...register('type')}>
                {ACTIVITY_TYPES.map((value) => (
                  <option key={value} value={value}>{LABELS[value]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Subject" htmlFor="subject" error={errors.subject?.message} required>
              <Input autoFocus {...register('subject')} />
            </Field>
          </div>

          <Field label="Notes" htmlFor="description" error={errors.description?.message}>
            <Textarea rows={3} {...register('description')} />
          </Field>

          {type === 'TASK' ? (
            <Field label="Due" htmlFor="dueAt" error={errors.dueAt?.message}>
              <Input type="datetime-local" defaultValue={toLocalInput()} {...register('dueAt')} />
            </Field>
          ) : null}

          {type === 'CALL' ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Direction" htmlFor="callDirection" error={errors.callDirection?.message}>
                <Select {...register('callDirection')}>
                  <option value="">—</option>
                  <option value="OUTBOUND">Outbound</option>
                  <option value="INBOUND">Inbound</option>
                </Select>
              </Field>
              <Field label="Duration (seconds)" htmlFor="callDurationSeconds" error={errors.callDurationSeconds?.message} hint="Logging a duration marks the call complete.">
                <Input type="number" min={0} {...register('callDurationSeconds')} />
              </Field>
              <Field label="Outcome" htmlFor="callOutcome" error={errors.callOutcome?.message}>
                <Input {...register('callOutcome')} />
              </Field>
            </div>
          ) : null}

          {type === 'EVENT' ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Starts" htmlFor="startAt" error={errors.startAt?.message} required>
                <Input type="datetime-local" {...register('startAt')} />
              </Field>
              <Field label="Ends" htmlFor="endAt" error={errors.endAt?.message}>
                <Input type="datetime-local" {...register('endAt')} />
              </Field>
              <Field label="Location" htmlFor="location" error={errors.location?.message}>
                <Input {...register('location')} />
              </Field>
            </div>
          ) : null}

          <Field label="Assigned to" htmlFor="assignedToId" error={errors.assignedToId?.message}>
            <Select {...register('assignedToId')}>
              <option value="">Unassigned</option>
              {agents.data?.items.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.firstName} {agent.lastName}</option>
              ))}
            </Select>
          </Field>
          <input type="hidden" {...register('ticketId')} />
          <input type="hidden" {...register('contactId')} />

          {errors.root ? <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">{errors.root.message}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={isSubmitting}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
