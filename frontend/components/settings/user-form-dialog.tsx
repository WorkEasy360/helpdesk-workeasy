'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  inviteUserSchema,
  type InviteUserFormValues,
  type InviteUserInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { departmentsService, rolesService, usersService } from '@/services/settings.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
}

/**
 * Invites an agent. No password is set here — the new user receives an invite email
 * and chooses their own, so a password never travels through an admin's browser.
 */
export function UserFormDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();

  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesService.list, enabled: open });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: departmentsService.list,
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserFormValues, unknown, InviteUserInput>({
    resolver: zodResolver(inviteUserSchema),
  });

  useEffect(() => {
    if (open) {
      reset({ firstName: '', lastName: '', email: '', roleIds: [], departmentIds: [] });
    }
  }, [open, reset]);

  const mutation = useMutation({
    mutationFn: (values: InviteUserInput) =>
      usersService.create(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Invitation sent');
      onOpenChange(false);
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to invite this agent.',
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite an agent</DialogTitle>
          <DialogDescription>
            They receive an email invitation and set their own password.
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
            <Field label="Last name" htmlFor="lastName" error={errors.lastName?.message} required>
              <Input {...register('lastName')} />
            </Field>
          </div>

          <Field label="Work email" htmlFor="email" error={errors.email?.message} required>
            <Input type="email" {...register('email')} />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-base font-medium">Roles</legend>
            {roles.isPending ? (
              <p className="text-base text-muted-foreground">Loading roles…</p>
            ) : (
              <div className="space-y-1">
                {roles.data
                  ?.filter((role) => role.systemKey !== 'CUSTOMER')
                  .map((role) => (
                    <label key={role.id} className="flex items-center gap-2 text-base">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        value={role.id}
                        {...register('roleIds')}
                      />
                      {role.name}
                    </label>
                  ))}
              </div>
            )}
            {errors.roleIds ? (
              <p role="alert" className="text-xs text-destructive">
                Choose at least one role
              </p>
            ) : null}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-base font-medium">Departments</legend>
            {departments.isPending ? (
              <p className="text-base text-muted-foreground">Loading departments…</p>
            ) : (
              <div className="space-y-1">
                {departments.data?.map((department) => (
                  <label key={department.id} className="flex items-center gap-2 text-base">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      value={department.id}
                      {...register('departmentIds')}
                    />
                    {department.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

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
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
