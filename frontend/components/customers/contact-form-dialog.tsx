'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CONTACT_STATUSES,
  createContactSchema,
  type ContactFormValues,
  type CreateContactInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { contactsService } from '@/services/contacts.service';
import { accountsService } from '@/services/accounts.service';
import type { ContactSummary } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: ContactSummary | null;
}

export function ContactFormDialog({ open, onOpenChange, contact }: Props) {
  const queryClient = useQueryClient();
  const editing = Boolean(contact);

  const accounts = useQuery({
    queryKey: ['accounts', 'options'],
    queryFn: () => accountsService.list({ page: 1, pageSize: 100, sort: 'name', order: 'asc' }),
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues, unknown, CreateContactInput>({
    resolver: zodResolver(createContactSchema),
  });

  useEffect(() => {
    if (!open) return;
    reset({
      firstName: contact?.firstName ?? '',
      lastName: contact?.lastName ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone ?? '',
      mobile: contact?.mobile ?? '',
      jobTitle: contact?.jobTitle ?? '',
      accountId: contact?.account?.id ?? '',
      status: contact?.status ?? 'ACTIVE',
      isVip: contact?.isVip ?? false,
    });
  }, [open, contact, reset]);

  const mutation = useMutation({
    mutationFn: (values: CreateContactInput) =>
      contact ? contactsService.update(contact.id, values) : contactsService.create(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(editing ? 'Contact updated' : 'Contact created');
      onOpenChange(false);
    },
    onError: (error) => {
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to save the contact.',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit contact' : 'New contact'}</DialogTitle>
          <DialogDescription>
            Contacts are the people who raise support requests.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit((values) => mutation.mutateAsync(values))}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="firstName" error={errors.firstName?.message} required>
              <Input autoFocus {...register('firstName')} />
            </Field>
            <Field label="Last name" htmlFor="lastName" error={errors.lastName?.message}>
              <Input {...register('lastName')} />
            </Field>
          </div>

          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input type="email" {...register('email')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone" htmlFor="phone" error={errors.phone?.message}>
              <Input {...register('phone')} />
            </Field>
            <Field label="Mobile" htmlFor="mobile" error={errors.mobile?.message}>
              <Input {...register('mobile')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job title" htmlFor="jobTitle" error={errors.jobTitle?.message}>
              <Input {...register('jobTitle')} />
            </Field>
            <Field label="Account" htmlFor="accountId" error={errors.accountId?.message}>
              <Select {...register('accountId')}>
                <option value="">No account</option>
                {accounts.data?.items.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status" htmlFor="status" error={errors.status?.message}>
              <Select {...register('status')}>
                {CONTACT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status.charAt(0) + status.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-base">
              <input type="checkbox" className="h-4 w-4 rounded border-input" {...register('isVip')} />
              Mark as VIP
            </label>
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
              {editing ? 'Save changes' : 'Create contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
