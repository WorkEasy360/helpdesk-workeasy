'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ASSIGNMENT_STRATEGIES, PERMISSIONS, assignmentRuleSchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { assignmentRulesService } from '@/services/operations.service';
import { departmentsService, teamsService, usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { AssignmentRule, ConditionTreeDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { ConditionEditor } from '@/components/operations/condition-editor';

const STRATEGY_LABELS: Record<(typeof ASSIGNMENT_STRATEGIES)[number], string> = {
  SPECIFIC_AGENT: 'A specific agent',
  DEPARTMENT: 'A department queue (nobody assigned)',
  ROUND_ROBIN: 'Round-robin across a department or team',
  LEAST_LOADED: 'Least-loaded agent in a department or team',
};

function RuleDialog({ open, onOpenChange, rule }: { open: boolean; onOpenChange: (o: boolean) => void; rule: AssignmentRule | null }) {
  const queryClient = useQueryClient();
  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list, enabled: open });
  const teams = useQuery({ queryKey: ['teams'], queryFn: teamsService.list, enabled: open });
  const agents = useQuery({ queryKey: ['users', 'assignable'], queryFn: () => usersService.list({ page: 1, pageSize: 100, isActive: true }), enabled: open });

  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<(typeof ASSIGNMENT_STRATEGIES)[number]>('ROUND_ROBIN');
  const [departmentId, setDepartmentId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [conditions, setConditions] = useState<ConditionTreeDto>({ all: [], any: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? '');
    setStrategy(rule?.strategy ?? 'ROUND_ROBIN');
    setDepartmentId(rule?.departmentId ?? '');
    setTeamId(rule?.teamId ?? '');
    setAgentId(rule?.agentId ?? '');
    setConditions(rule?.conditions ?? { all: [], any: [] });
    setError(null);
  }, [open, rule]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = assignmentRuleSchema.safeParse({ name, strategy, departmentId, teamId, agentId, conditions, isActive: rule?.isActive ?? true, position: rule?.position ?? 0 });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError('VALIDATION_ERROR', issue?.message ?? 'Invalid rule', 400);
      }
      return rule ? assignmentRulesService.update(rule.id, parsed.data) : assignmentRulesService.create(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
      toast.success(rule ? 'Rule updated' : 'Rule created');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save.'),
  });

  const needsAgent = strategy === 'SPECIFIC_AGENT';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit assignment rule' : 'New assignment rule'}</DialogTitle>
          <DialogDescription>Rules run in order when a ticket is created; the first match decides where it goes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name" htmlFor="ar-name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Route to" htmlFor="ar-strategy" required>
            <Select value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
              {ASSIGNMENT_STRATEGIES.map((s) => <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>)}
            </Select>
          </Field>
          {needsAgent ? (
            <Field label="Agent" htmlFor="ar-agent" required>
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Choose…</option>
                {agents.data?.items.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Department" htmlFor="ar-dept">
                <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">—</option>
                  {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
              <Field label="Team" htmlFor="ar-team" hint="Narrows the agent pool to one team.">
                <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">—</option>
                  {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
            </div>
          )}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Applies when</h3>
            <ConditionEditor value={conditions} onChange={setConditions} />
          </section>
          {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{rule ? 'Save changes' : 'Create rule'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AssignmentRulesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.OPERATIONS_MANAGE);
  const [dialog, setDialog] = useState<{ open: boolean; rule: AssignmentRule | null }>({ open: false, rule: null });
  const rules = useQuery({ queryKey: ['assignment-rules'], queryFn: assignmentRulesService.list });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['assignment-rules'] });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => assignmentRulesService.reorder(ids),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to reorder.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => assignmentRulesService.remove(id),
    onSuccess: async () => { await refresh(); toast.success('Rule deleted'); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });
  const toggle = useMutation({
    mutationFn: (rule: AssignmentRule) => assignmentRulesService.update(rule.id, { isActive: !rule.isActive }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update.'),
  });

  const move = (index: number, delta: number) => {
    const ids = (rules.data ?? []).map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    reorder.mutate(ids);
  };

  return (
    <>
      <div className="flex justify-end">{manage ? <Button onClick={() => setDialog({ open: true, rule: null })}><Plus className="h-4 w-4" aria-hidden />New rule</Button> : null}</div>
      <Card>
        <CardHeader>
          <CardTitle>Assignment rules</CardTitle>
          <CardDescription>Evaluated top to bottom on every new ticket an agent leaves unassigned. The first match wins.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rules.isPending ? <TableSkeleton columns={3} /> : rules.isError ? (
            <ErrorState message="Unable to load assignment rules." onRetry={() => rules.refetch()} />
          ) : rules.data.length === 0 ? (
            <EmptyState title="No assignment rules" description="New tickets stay unassigned until an agent picks them up." action={manage ? <Button onClick={() => setDialog({ open: true, rule: null })}>New rule</Button> : null} />
          ) : (
            <ol className="divide-y divide-border">
              {rules.data.map((rule, index) => (
                <li key={rule.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{rule.name}{!rule.isActive ? <Badge className="ml-2">Disabled</Badge> : null}</p>
                    <p className="text-xs text-muted-foreground">
                      {STRATEGY_LABELS[rule.strategy]}
                      {rule.agent ? ` → ${rule.agent.firstName} ${rule.agent.lastName}` : ''}
                      {rule.department ? ` → ${rule.department.name}` : ''}
                      {rule.team ? ` (${rule.team.name})` : ''}
                      {' · '}{rule.conditions.all.length + rule.conditions.any.length} condition(s)
                    </p>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" aria-hidden /></Button>
                      <Button variant="ghost" size="icon" aria-label="Move down" disabled={index === rules.data.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" aria-hidden /></Button>
                      <Button variant="outline" size="sm" onClick={() => toggle.mutate(rule)}>{rule.isActive ? 'Disable' : 'Enable'}</Button>
                      <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setDialog({ open: true, rule })}><Pencil className="h-4 w-4" aria-hidden /></Button>
                      <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void confirm({ title: `Delete "${rule.name}"?`, confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(rule.id) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      <RuleDialog open={dialog.open} onOpenChange={(open) => setDialog({ open, rule: open ? dialog.rule : null })} rule={dialog.rule} />
    </>
  );
}
