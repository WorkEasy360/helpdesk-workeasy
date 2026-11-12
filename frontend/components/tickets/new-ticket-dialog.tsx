'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  TICKET_SOURCES,
  createTicketSchema,
  type CreateTicketInput,
  type TicketFormValues,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { ticketConfigService, ticketsService } from '@/services/tickets.service';
import { contactsService } from '@/services/contacts.service';
import { departmentsService } from '@/services/settings.service';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function NewTicketDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const contacts = useQuery({
    queryKey: ['contacts', 'options'],
    queryFn: () => contactsService.list({ page: 1, pageSize: 100, sort: 'lastName', order: 'asc' }),
    enabled: open,
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: departmentsService.list,
    enabled: open,
  });
  const priorities = useQuery({
    queryKey: ['ticket-priorities'],
    queryFn: ticketConfigService.priorities,
    enabled: open,
  });
  const categories = useQuery({
    queryKey: ['ticket-categories'],
    queryFn: ticketConfigService.categories,
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<TicketFormValues, unknown, CreateTicketInput>({
    resolver: zodResolver(createTicketSchema),
  });

  useEffect(() => {
    if (open) {
      reset({ subject: '', description: '', source: 'AGENT', tagIds: [] });
    }
  }, [open, reset]);

  const create = useMutation({
    mutationFn: (values: CreateTicketInput) => ticketsService.create(values),
    onSuccess: async (ticket) => {
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
      toast.success(`Ticket #${ticket.ticketNumber} created`);
      onOpenChange(false);
      router.push(`/tickets/${ticket.id}`);
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to create the ticket.',
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Raise a request on a customer&apos;s behalf. It lands in the queue immediately.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit((values) => create.mutateAsync(values))}
          className="space-y-4"
          noValidate
        >
          <Field label="Subject" htmlFor="subject" error={errors.subject?.message} required>
            <Input autoFocus {...register('subject')} />
          </Field>

          <Field label="Description" htmlFor="description" error={errors.description?.message} required>
            <Textarea rows={5} {...register('description')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Requester" htmlFor="contactId" error={errors.contactId?.message}>
              <Select {...register('contactId')}>
                <option value="">No contact</option>
                {contacts.data?.items.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.firstName} {contact.lastName ?? ''} {contact.email ? `· ${contact.email}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" htmlFor="departmentId" error={errors.departmentId?.message}>
              <Select {...register('departmentId')}>
                <option value="">Unassigned</option>
                {departments.data?.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Priority" htmlFor="priorityId" error={errors.priorityId?.message}>
              <Select {...register('priorityId')}>
                <option value="">Default</option>
                {priorities.data?.map((priority) => (
                  <option key={priority.id} value={priority.id}>
                    {priority.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="categoryId" error={errors.categoryId?.message}>
              <Select {...register('categoryId')}>
                <option value="">None</option>
                {categories.data?.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source" htmlFor="source" error={errors.source?.message}>
              <Select {...register('source')}>
                {TICKET_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source.charAt(0) + source.slice(1).toLowerCase().replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {errors.root ? (
            <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
              {errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
