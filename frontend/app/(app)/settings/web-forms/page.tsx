'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { helpCenterService } from '@/services/help-center.service';
import { useAuthStore } from '@/stores/auth.store';
import type { WebForm } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { WebFormDialog } from '@/components/help-center/web-form-dialog';

export default function WebFormsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.PORTAL_MANAGE);
  const [dialog, setDialog] = useState<{ open: boolean; form: WebForm | null }>({ open: false, form: null });

  const forms = useQuery({ queryKey: ['web-forms'], queryFn: helpCenterService.forms });
  const helpCenter = useQuery({ queryKey: ['help-center'], queryFn: helpCenterService.get });

  const remove = useMutation({
    mutationFn: (id: string) => helpCenterService.removeForm(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['web-forms'] });
      toast.success('Form deleted');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  return (
    <>
      <div className="flex justify-end">
        {manage ? (
          <Button onClick={() => setDialog({ open: true, form: null })}>
            <Plus className="h-4 w-4" aria-hidden />
            New form
          </Button>
        ) : null}
      </div>

      <Card>
        {forms.isPending ? (
          <TableSkeleton columns={4} />
        ) : forms.isError ? (
          <ErrorState
            message={forms.error instanceof ApiError ? forms.error.message : 'Unable to load forms.'}
            onRetry={() => forms.refetch()}
          />
        ) : forms.data.length === 0 ? (
          <EmptyState
            title="No web forms yet"
            description="A web form turns a customer's answers into a ticket, routed the way you choose."
            action={manage ? <Button onClick={() => setDialog({ open: true, form: null })}>New form</Button> : null}
          />
        ) : (
          <DataTable>
            <THead>
              <TR>
                <TH>Form</TH>
                <TH>Routing</TH>
                <TH>Fields</TH>
                <TH className="text-right">Submissions</TH>
                <TH>
                  <span className="sr-only">Manage</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {forms.data.map((form) => (
                <TR key={form.id}>
                  <TD>
                    <p className="font-medium">{form.name}</p>
                    <p className="text-xs text-muted-foreground">
                      /{form.slug}
                      {form.requireLogin ? ' · sign-in required' : ''}
                    </p>
                  </TD>
                  <TD className="text-sm text-muted-foreground">
                    {form.department?.name ?? 'Assignment rules'}
                    {form.priority ? ` · ${form.priority.name}` : ''}
                  </TD>
                  <TD className="text-sm text-muted-foreground">{form.fields.length}</TD>
                  <TD className="text-right text-sm">{form.submissionCount}</TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      {helpCenter.data ? (
                        <Button asChild variant="ghost" size="icon" aria-label={`Open ${form.name}`}>
                          <Link href={`/help/${helpCenter.data.slug}/submit?form=${form.slug}`} target="_blank">
                            <ExternalLink className="h-4 w-4" aria-hidden />
                          </Link>
                        </Button>
                      ) : null}
                      {manage ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit ${form.name}`}
                            onClick={() => setDialog({ open: true, form })}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${form.name}`}
                            onClick={() =>
                              void confirm({
                                title: `Delete ${form.name}?`,
                                description: 'Customers will no longer be able to submit this form.',
                                confirmLabel: 'Delete form',
                                onConfirm: () => remove.mutateAsync(form.id),
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </Card>

      <WebFormDialog
        form={dialog.form}
        open={dialog.open}
        onOpenChange={(open) => setDialog({ open, form: open ? dialog.form : null })}
      />
    </>
  );
}
