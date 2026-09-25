'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  createDepartmentSchema,
  type CreateDepartmentInput,
  type DepartmentFormValues,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { departmentsService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { Department } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

export default function DepartmentsSettingsPage() {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpenState] = useState(false);
  // The department being edited; null while creating a new one.
  const [editing, setEditing] = useState<Department | null>(null);

  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DepartmentFormValues, unknown, CreateDepartmentInput>({
    resolver: zodResolver(createDepartmentSchema),
  });

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) setEditing(null);
  };

  const startCreate = () => {
    setEditing(null);
    reset({ name: '', description: '', email: '', isDefault: false });
    setOpenState(true);
  };

  const startEdit = (department: Department) => {
    setEditing(department);
    reset({
      name: department.name,
      description: department.description ?? '',
      email: department.email ?? '',
      isDefault: department.isDefault,
    });
    setOpenState(true);
  };

  const save = useMutation({
    mutationFn: (values: CreateDepartmentInput) =>
      editing
        ? departmentsService.update(editing.id, {
            ...values,
            // A disabled checkbox submits nothing; keep the current default explicitly.
            isDefault: editing.isDefault || values.isDefault,
          })
        : departmentsService.create(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      toast.success(editing ? 'Department updated' : 'Department created');
      reset({ name: '', description: '', email: '', isDefault: false });
      setOpen(false);
    },
    onError: (error) =>
      setError('root', {
        message:
          error instanceof ApiError
            ? error.message
            : editing
              ? 'Unable to update the department.'
              : 'Unable to create the department.',
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => departmentsService.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
      toast.success('Department deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to delete the department.'),
  });

  return (
    <>
      <div className="flex justify-end">
        {can(PERMISSIONS.DEPARTMENT_MANAGE) ? (
          <Button onClick={startCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            New department
          </Button>
        ) : null}
      </div>

      <Card>
        {departments.isPending ? (
          <TableSkeleton columns={4} />
        ) : departments.isError ? (
          <ErrorState message="Unable to load departments." onRetry={() => departments.refetch()} />
        ) : departments.data.length === 0 ? (
          <EmptyState title="No departments yet" description="Departments group agents and route work." />
        ) : (
          <DataTable>
            <THead>
              <TR>
                <TH>Department</TH>
                <TH>Email</TH>
                <TH className="text-right">Agents</TH>
                <TH className="text-right">Teams</TH>
                <TH><span className="sr-only">Actions</span></TH>
              </TR>
            </THead>
            <TBody>
              {departments.data.map((department) => (
                <TR key={department.id}>
                  <TD>
                    <p className="font-medium">
                      {department.name}
                      {department.isDefault ? (
                        <Badge variant="outline" className="ml-2">
                          Default
                        </Badge>
                      ) : null}
                    </p>
                    {department.description ? (
                      <p className="text-xs text-muted-foreground">{department.description}</p>
                    ) : null}
                  </TD>
                  <TD className="text-muted-foreground">{department.email ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{department._count.members}</TD>
                  <TD className="text-right tabular-nums">{department._count.teams}</TD>
                  <TD className="text-right">
                    {can(PERMISSIONS.DEPARTMENT_MANAGE) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${department.name}`}
                        onClick={() => startEdit(department)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                    {can(PERMISSIONS.DEPARTMENT_MANAGE) && !department.isDefault ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${department.name}`}
                        onClick={() =>
                          void confirm({
                            title: `Delete ${department.name}?`,
                            description: 'This cannot be undone.',
                            confirmLabel: 'Delete',
                            onConfirm: () => remove.mutateAsync(department.id).catch(() => undefined),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'New department'}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={handleSubmit((values) => save.mutateAsync(values))}
            className="space-y-4"
            noValidate
          >
            <Field label="Name" htmlFor="name" error={errors.name?.message} required>
              <Input autoFocus {...register('name')} />
            </Field>
            <Field
              label="Support email"
              htmlFor="email"
              error={errors.email?.message}
              hint="Used to route inbound email to this department."
            >
              <Input type="email" {...register('email')} />
            </Field>
            <Field label="Description" htmlFor="description" error={errors.description?.message}>
              <Textarea rows={2} {...register('description')} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                // The default cannot be un-set directly: another department has to take over.
                disabled={editing?.isDefault ?? false}
                {...register('isDefault')}
              />
              Default department for new tickets
            </label>
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
                {editing ? 'Save changes' : 'Create department'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
