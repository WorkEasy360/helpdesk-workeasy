'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createAccountSchema,
  type AccountFormValues,
  type CreateAccountInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { accountsService } from '@/services/accounts.service';
import type { AccountDetail, AccountSummary } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
  account?: AccountSummary | AccountDetail | null;
}

export function AccountFormDialog({ open, onOpenChange, account }: Props) {
  const queryClient = useQueryClient();
  const editing = Boolean(account);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues, unknown, CreateAccountInput>({
    resolver: zodResolver(createAccountSchema),
  });

  useEffect(() => {
    if (!open) return;
    const detail = account as AccountDetail | undefined;
    reset({
      name: account?.name ?? '',
      website: account?.website ?? '',
      industry: account?.industry ?? '',
      phone: account?.phone ?? '',
      email: account?.email ?? '',
      city: account?.city ?? '',
      country: account?.country ?? '',
      addressLine1: detail?.addressLine1 ?? '',
      description: detail?.description ?? '',
    });
  }, [open, account, reset]);

  const mutation = useMutation({
    mutationFn: (values: CreateAccountInput) =>
      account ? accountsService.update(account.id, values) : accountsService.create(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(editing ? 'Account updated' : 'Account created');
      onOpenChange(false);
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to save the account.',
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit account' : 'New account'}</DialogTitle>
          <DialogDescription>Accounts are the companies your contacts belong to.</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit((values) => mutation.mutateAsync(values))}
          className="space-y-4"
          noValidate
        >
          <Field label="Company name" htmlFor="name" error={errors.name?.message} required>
            <Input autoFocus {...register('name')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Website"
              htmlFor="website"
              error={errors.website?.message}
              hint="Include https://"
            >
              <Input {...register('website')} />
            </Field>
            <Field label="Industry" htmlFor="industry" error={errors.industry?.message}>
              <Input {...register('industry')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" htmlFor="email" error={errors.email?.message}>
              <Input type="email" {...register('email')} />
            </Field>
            <Field label="Phone" htmlFor="phone" error={errors.phone?.message}>
              <Input {...register('phone')} />
            </Field>
          </div>

          <Field label="Address" htmlFor="addressLine1" error={errors.addressLine1?.message}>
            <Input {...register('addressLine1')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="City" htmlFor="city" error={errors.city?.message}>
              <Input {...register('city')} />
            </Field>
            <Field label="Country" htmlFor="country" error={errors.country?.message}>
              <Input {...register('country')} />
            </Field>
          </div>

          <Field label="Notes" htmlFor="description" error={errors.description?.message}>
            <Textarea rows={3} {...register('description')} />
          </Field>

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
              {editing ? 'Save changes' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
