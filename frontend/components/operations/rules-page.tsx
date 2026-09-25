'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { automationRulesService } from '@/services/operations.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import type { AutomationRule } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { RuleFormDialog, TRIGGER_LABELS } from './rule-form-dialog';

/** Shared by the workflow-rules and escalations tabs; only the trigger set differs. */
export function RulesPage({ escalation }: { escalation: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.OPERATIONS_MANAGE);
  const [dialog, setDialog] = useState<{ open: boolean; rule: AutomationRule | null }>({ open: false, rule: null });

  const rules = useQuery({ queryKey: ['automation-rules', { escalation }], queryFn: () => automationRulesService.list(escalation) });
  const runs = useQuery({ queryKey: ['automation-runs', { escalation }], queryFn: () => automationRulesService.runs({ page: 1, pageSize: 20 }) });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['automation-rules'] });
  };
  const toggle = useMutation({
    mutationFn: (rule: AutomationRule) => (rule.isActive ? automationRulesService.disable(rule.id) : automationRulesService.enable(rule.id)),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => automationRulesService.remove(id),
    onSuccess: async () => { await refresh(); toast.success('Rule deleted'); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  const relevantRuns = runs.data?.items.filter((run) => ['SLA_WARNING', 'SLA_BREACHED'].includes(run.trigger) === escalation) ?? [];

  return (
    <>
      <div className="flex justify-end">
        {manage ? <Button onClick={() => setDialog({ open: true, rule: null })}><Plus className="h-4 w-4" aria-hidden />{escalation ? 'New escalation' : 'New rule'}</Button> : null}
      </div>
      <Card>
        {rules.isPending ? <TableSkeleton columns={5} /> : rules.isError ? (
          <ErrorState message={rules.error instanceof ApiError ? rules.error.message : 'Unable to load rules.'} onRetry={() => rules.refetch()} />
        ) : rules.data.length === 0 ? (
          <EmptyState title={escalation ? 'No escalations yet' : 'No workflow rules yet'}
            description={escalation ? 'Decide what happens when an SLA is about to slip: bump the priority, notify a team, reassign.' : 'Automate the routine: tag, prioritise, assign and notify based on what a ticket looks like.'}
            action={manage ? <Button onClick={() => setDialog({ open: true, rule: null })}>{escalation ? 'New escalation' : 'New rule'}</Button> : null} />
        ) : (
          <DataTable>
            <THead><TR><TH>Rule</TH><TH>Trigger</TH><TH>Actions</TH><TH className="text-right">Runs</TH><TH>Last run</TH><TH><span className="sr-only">Manage</span></TH></TR></THead>
            <TBody>
              {rules.data.map((rule) => (
                <TR key={rule.id}>
                  <TD>
                    <p className="font-medium">{rule.name}{!rule.isActive ? <Badge className="ml-2">Disabled</Badge> : null}</p>
                    {rule.description ? <p className="text-xs text-muted-foreground">{rule.description}</p> : null}
                    <p className="text-xs text-muted-foreground">{rule.conditions.all.length + rule.conditions.any.length} condition(s)</p>
                  </TD>
                  <TD className="text-muted-foreground">{TRIGGER_LABELS[rule.trigger] ?? rule.trigger}</TD>
                  <TD className="text-muted-foreground">{rule.actions.map((a) => String(a.type).replace(/_/g, ' ')).join(', ')}</TD>
                  <TD className="text-right tabular-nums">{rule.runCount}</TD>
                  <TD className="text-muted-foreground">{formatDateTime(rule.lastRunAt)}</TD>
                  <TD className="text-right">
                    {manage ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label={rule.isActive ? 'Disable' : 'Enable'} onClick={() => toggle.mutate(rule)}><Power className="h-4 w-4" aria-hidden /></Button>
                        <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setDialog({ open: true, rule })}><Pencil className="h-4 w-4" aria-hidden /></Button>
                        <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void confirm({ title: `Delete "${rule.name}"?`, confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(rule.id) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>Every evaluation is recorded, including the ones that did not match.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {runs.isPending ? <TableSkeleton columns={4} rows={3} /> : relevantRuns.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <DataTable>
              <THead><TR><TH>When</TH><TH>Rule</TH><TH>Ticket</TH><TH>Result</TH></TR></THead>
              <TBody>
                {relevantRuns.map((run) => (
                  <TR key={run.id}>
                    <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(run.createdAt)}</TD>
                    <TD>{run.rule.name}</TD>
                    <TD className="text-muted-foreground">{run.ticket ? `#${run.ticket.ticketNumber} ${run.ticket.subject}` : '—'}</TD>
                    <TD>
                      {run.error ? <Badge variant="danger">error</Badge> : run.matched ? <Badge variant="success">fired</Badge> : <Badge>no match</Badge>}
                      {run.error ? <p className="mt-1 text-xs text-muted-foreground">{run.error}</p> : null}
                      {run.actionsApplied?.outcomes ? (
                        <p className="mt-1 text-xs text-muted-foreground">{run.actionsApplied.outcomes.map((o) => `${o.type.replace(/_/g, ' ')}${o.ok ? '' : ` (${o.detail})`}`).join(', ')}</p>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <RuleFormDialog open={dialog.open} onOpenChange={(open) => setDialog({ open, rule: open ? dialog.rule : null })} rule={dialog.rule} escalation={escalation} />
    </>
  );
}
