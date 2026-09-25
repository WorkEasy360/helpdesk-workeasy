'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { UserFormDialog } from '@/components/settings/user-form-dialog';
import { UserEditDialog } from '@/components/settings/user-edit-dialog';
import type { UserSummary } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

export default function UsersSettingsPage() {
  const can = useAuthStore((state) => state.can);
  const currentUser = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);

  const users = useQuery({
    queryKey: ['users', { page }],
    queryFn: () => usersService.list({ page, pageSize: 25 }),
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      active ? usersService.activate(id) : usersService.deactivate(id),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(variables.active ? 'Agent activated' : 'Agent deactivated');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to update the agent.'),
  });

  const resendInvite = useMutation({
    mutationFn: (id: string) => usersService.resendInvite(id),
    onSuccess: () => toast.success('Invitation sent'),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to send the invitation.'),
  });

  return (
    <>
      <div className="flex justify-end">
        {can(PERMISSIONS.USER_CREATE) ? (
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Invite agent
          </Button>
        ) : null}
      </div>

      <Card>
        {users.isPending ? (
          <TableSkeleton columns={5} />
        ) : users.isError ? (
          <ErrorState
            message={users.error instanceof ApiError ? users.error.message : 'Unable to load agents.'}
            onRetry={() => users.refetch()}
          />
        ) : users.data.items.length === 0 ? (
          <EmptyState title="No agents yet" description="Invite the first member of your support team." />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH>Roles</TH>
                  <TH>Departments</TH>
                  <TH>Status</TH>
                  <TH>Last sign-in</TH>
                  <TH><span className="sr-only">Actions</span></TH>
                </TR>
              </THead>
              <TBody>
                {users.data.items.map((user) => (
                  <TR key={user.id}>
                    <TD>
                      <p className="font-medium">
                        {user.firstName} {user.lastName}
                        {user.id === currentUser?.id ? (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </TD>
                    <TD className="text-muted-foreground">
                      {user.roles.map((r) => r.role.name).join(', ') || '—'}
                    </TD>
                    <TD className="text-muted-foreground">
                      {user.departments.map((d) => d.department.name).join(', ') || '—'}
                    </TD>
                    <TD>
                      <Badge variant={user.isActive ? 'success' : 'default'}>
                        {user.isActive ? 'Active' : 'Deactivated'}
                      </Badge>
                      {!user.emailVerifiedAt ? (
                        <Badge variant="warning" className="ml-2">
                          Invite pending
                        </Badge>
                      ) : null}
                    </TD>
                    <TD className="text-muted-foreground">{formatDateTime(user.lastLoginAt)}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        {can(PERMISSIONS.USER_CREATE) && !user.emailVerifiedAt ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Resend invitation to ${user.email}`}
                            onClick={() => resendInvite.mutate(user.id)}
                          >
                            <Mail className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                        {can(PERMISSIONS.USER_UPDATE) ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${user.firstName} ${user.lastName}`}
                            onClick={() => setEditing(user)}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                        {can(PERMISSIONS.USER_UPDATE) && user.id !== currentUser?.id ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              if (
                                user.isActive &&
                                !(await confirm({
                                  title: `Deactivate ${user.firstName} ${user.lastName}?`,
                                  description: 'They will be signed out and unable to sign in until reactivated.',
                                  confirmLabel: 'Deactivate',
                                }))
                              ) {
                                return;
                              }
                              setActive.mutate({ id: user.id, active: !user.isActive });
                            }}
                          >
                            {user.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
            <Pagination meta={users.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>

      <UserFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <UserEditDialog
        user={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </>
  );
}
