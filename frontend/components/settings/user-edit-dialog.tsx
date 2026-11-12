'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { departmentsService, rolesService, usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { UserSummary } from '@/types/api';
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

const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'Required').max(80),
  lastName: z.string().trim().min(1, 'Required').max(80),
  phone: z.string().trim().max(40),
});
type ProfileValues = z.infer<typeof profileSchema>;

interface Props {
  user: UserSummary | null;
  onOpenChange: (open: boolean) => void;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Edits an agent's profile, roles and departments. Each part has its own endpoint (and
 * roles their own permission), so only what changed is sent, in order, and a refusal is
 * reported against the part that failed.
 */
export function UserEditDialog({ user, onOpenChange }: Props) {
  const open = user !== null;
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const canManageRoles = can(PERMISSIONS.ROLE_MANAGE);

  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesService.list, enabled: open });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: departmentsService.list,
    enabled: open,
  });

  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [roleError, setRoleError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProfileValues>({ resolver: zodResolver(profileSchema) });

  useEffect(() => {
    if (user) {
      reset({ firstName: user.firstName, lastName: user.lastName, phone: user.phone ?? '' });
      setRoleIds(user.roles.map((entry) => entry.role.id));
      setDepartmentIds(user.departments.map((entry) => entry.department.id));
      setRoleError(null);
    }
  }, [user, reset]);

  const toggle = (list: string[], id: string, checked: boolean) =>
    checked ? [...list, id] : list.filter((value) => value !== id);

  const onSubmit = handleSubmit(async (values) => {
    if (!user) return;
    if (roleIds.length === 0) {
      setRoleError('Choose at least one role');
      return;
    }
    setRoleError(null);

    let step: 'profile' | 'roles' | 'departments' = 'profile';
    try {
      const phone = values.phone || null;
      if (
        values.firstName !== user.firstName ||
        values.lastName !== user.lastName ||
        phone !== (user.phone ?? null)
      ) {
        await usersService.update(user.id, {
          firstName: values.firstName,
          lastName: values.lastName,
          phone,
        });
      }

      step = 'roles';
      const currentRoles = user.roles.map((entry) => entry.role.id);
      if (canManageRoles && !sameSet(roleIds, currentRoles)) {
        await usersService.setRoles(user.id, roleIds);
      }

      step = 'departments';
      const currentDepartments = user.departments.map((entry) => entry.department.id);
      if (!sameSet(departmentIds, currentDepartments)) {
        await usersService.setDepartments(user.id, departmentIds);
      }

      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Agent updated');
      onOpenChange(false);
    } catch (error) {
      // Earlier steps may have been saved; refresh so the table reflects them.
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      if (step === 'roles' && error instanceof ApiError && error.status === 403) {
        const message =
          'You cannot assign a role with more privileges than your own. Ask an administrator with a higher role to make this change.';
        setRoleError(message);
        toast.error(message);
        return;
      }
      const fallback =
        step === 'roles'
          ? 'Unable to update roles.'
          : step === 'departments'
            ? 'Unable to update departments.'
            : 'Unable to update the agent.';
      const message = error instanceof ApiError ? error.message : fallback;
      setError('root', { message });
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit agent</DialogTitle>
          <DialogDescription>{user?.email}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="First name"
              htmlFor="edit-firstName"
              error={errors.firstName?.message}
              required
            >
              <Input autoFocus {...register('firstName')} />
            </Field>
            <Field
              label="Last name"
              htmlFor="edit-lastName"
              error={errors.lastName?.message}
              required
            >
              <Input {...register('lastName')} />
            </Field>
          </div>

          <Field label="Phone" htmlFor="edit-phone" error={errors.phone?.message}>
            <Input type="tel" {...register('phone')} />
          </Field>

          <fieldset className="space-y-2" disabled={!canManageRoles}>
            <legend className="text-base font-medium">Roles</legend>
            {!canManageRoles ? (
              <p className="text-xs text-muted-foreground">
                You need the role management permission to change roles.
              </p>
            ) : null}
            {roles.isPending ? (
              <p className="text-base text-muted-foreground">Loading roles…</p>
            ) : roles.isError ? (
              <p className="text-base text-destructive">Unable to load roles.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {roles.data
                  .filter((role) => role.systemKey !== 'CUSTOMER')
                  .map((role) => (
                    <label key={role.id} className="flex items-center gap-2 text-base">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={roleIds.includes(role.id)}
                        onChange={(event) =>
                          setRoleIds((current) => toggle(current, role.id, event.target.checked))
                        }
                      />
                      {role.name}
                    </label>
                  ))}
              </div>
            )}
            {roleError ? (
              <p role="alert" className="text-xs text-destructive">
                {roleError}
              </p>
            ) : null}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-base font-medium">Departments</legend>
            {departments.isPending ? (
              <p className="text-base text-muted-foreground">Loading departments…</p>
            ) : departments.isError ? (
              <p className="text-base text-destructive">Unable to load departments.</p>
            ) : departments.data.length === 0 ? (
              <p className="text-base text-muted-foreground">No departments yet.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {departments.data.map((department) => (
                  <label key={department.id} className="flex items-center gap-2 text-base">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      checked={departmentIds.includes(department.id)}
                      onChange={(event) =>
                        setDepartmentIds((current) =>
                          toggle(current, department.id, event.target.checked),
                        )
                      }
                    />
                    {department.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {errors.root ? (
            <p
              role="alert"
              className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive"
            >
              {errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
