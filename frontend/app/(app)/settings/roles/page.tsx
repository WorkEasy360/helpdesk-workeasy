'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  createRoleSchema,
  type CreateRoleInput,
  type RoleFormValues,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { rolesService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { Role } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/ui/states';

export default function RolesSettingsPage() {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpenState] = useState(false);
  // The role being edited; null while creating a new one.
  const [editing, setEditing] = useState<Role | null>(null);
  const canManage = can(PERMISSIONS.ROLE_MANAGE);

  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesService.list });
  const permissions = useQuery({ queryKey: ['permissions'], queryFn: rolesService.permissions });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RoleFormValues, unknown, CreateRoleInput>({
    resolver: zodResolver(createRoleSchema),
    defaultValues: { permissionKeys: [] },
  });

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) setEditing(null);
  };

  const startCreate = () => {
    setEditing(null);
    reset({ name: '', description: '', permissionKeys: [] });
    setOpenState(true);
  };

  const startEdit = (role: Role) => {
    setEditing(role);
    reset({
      name: role.name,
      description: role.description ?? '',
      permissionKeys: role.permissions.map((entry) => entry.permission.key),
    });
    setOpenState(true);
  };

  const save = useMutation({
    mutationFn: (values: CreateRoleInput) => {
      if (!editing) return rolesService.create(values);
      // Always send the full set: the API treats a missing list as an empty one.
      return rolesService.update(editing.id, {
        name: values.name,
        description: values.description,
        permissionKeys: values.permissionKeys,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      // Holders of the role see their permissions change on their next request.
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(editing ? 'Role updated' : 'Role created');
      reset({ name: '', description: '', permissionKeys: [] });
      setOpen(false);
    },
    onError: (error) =>
      setError('root', {
        message:
          error instanceof ApiError
            ? error.message
            : editing
              ? 'Unable to update the role.'
              : 'Unable to create the role.',
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => rolesService.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast.success('Role deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to delete the role.'),
  });

  if (roles.isPending) return <LoadingState />;
  if (roles.isError) {
    return (
      <ErrorState
        message={roles.error instanceof ApiError ? roles.error.message : 'Unable to load roles.'}
        onRetry={() => roles.refetch()}
      />
    );
  }

  return (
    <>
      <div className="flex justify-end">
        {canManage ? (
          <Button onClick={startCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            New role
          </Button>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.data.map((role) => (
          <Card key={role.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle>{role.name}</CardTitle>
                <div className="flex items-center gap-1">
                  {role.isSystem ? <Badge variant="outline">System</Badge> : null}
                  {/* Built-in roles are fixed by the platform (the API refuses permission
                      changes to them), so only custom roles are editable. */}
                  {canManage && !role.isSystem ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${role.name}`}
                      onClick={() => startEdit(role)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                  {canManage && !role.isSystem ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${role.name}`}
                      onClick={() =>
                        void confirm({
                          title: `Delete ${role.name}?`,
                          description: 'This cannot be undone.',
                          confirmLabel: 'Delete',
                          onConfirm: () => remove.mutateAsync(role.id).catch(() => undefined),
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </div>
              <CardDescription>{role.description ?? 'No description'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {role._count.users} {role._count.users === 1 ? 'agent' : 'agents'} ·{' '}
                {role.permissions.length} permissions
              </p>
              <div className="flex flex-wrap gap-1">
                {role.permissions.slice(0, 8).map((entry) => (
                  <Badge key={entry.permission.key} className="font-mono text-[10px]">
                    {entry.permission.key}
                  </Badge>
                ))}
                {role.permissions.length > 8 ? (
                  <Badge variant="outline">+{role.permissions.length - 8} more</Badge>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Permission catalogue</CardTitle>
          <CardDescription>Every key the backend authorises against.</CardDescription>
        </CardHeader>
        <CardContent>
          {permissions.isPending ? (
            <LoadingState />
          ) : permissions.isError ? (
            <ErrorState message="Unable to load permissions." onRetry={() => permissions.refetch()} />
          ) : (
            <div className="flex flex-wrap gap-1">
              {permissions.data.map((permission) => (
                <Badge key={permission.key} variant="outline" className="font-mono text-[10px]">
                  {permission.key}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'New role'}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={handleSubmit((values) => save.mutateAsync(values))}
            className="space-y-4"
            noValidate
          >
            <Field label="Name" htmlFor="name" error={errors.name?.message} required>
              <Input autoFocus {...register('name')} />
            </Field>
            <Field label="Description" htmlFor="description" error={errors.description?.message}>
              <Textarea rows={2} {...register('description')} />
            </Field>

            <fieldset className="space-y-2" disabled={editing?.isSystem ?? false}>
              <legend className="text-sm font-medium">Permissions</legend>
              {editing?.isSystem ? (
                <p className="text-xs text-muted-foreground">
                  This is a built-in role, so its permissions cannot be changed. Create a new
                  role to grant a different set.
                </p>
              ) : null}
              {permissions.isPending ? (
                <p className="text-sm text-muted-foreground">Loading permissions…</p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {permissions.data?.map((permission) => (
                    <label key={permission.key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        value={permission.key}
                        {...register('permissionKeys')}
                      />
                      <span className="font-mono text-xs">{permission.key}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            {errors.root ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errors.root.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={isSubmitting}>
                {editing ? 'Save changes' : 'Create role'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
