'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, slaPolicySchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { slaPoliciesService } from '@/services/operations.service';
import { ticketConfigService } from '@/services/tickets.service';
import { organizationService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { ConditionTreeDto, SlaPolicy } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ConditionEditor } from '@/components/operations/condition-editor';

interface TargetDraft { priorityId: string; firstResponseMinutes: number; resolutionMinutes: number; useBusinessHours: boolean }

function minutes(value: number): string {
  if (value % (24 * 60) === 0) return `${value / (24 * 60)}d`;
  if (value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

function PolicyDialog({ open, onOpenChange, policy }: { open: boolean; onOpenChange: (o: boolean) => void; policy: SlaPolicy | null }) {
  const queryClient = useQueryClient();
  const priorities = useQuery({ queryKey: ['ticket-priorities'], queryFn: ticketConfigService.priorities, enabled: open });
  const calendars = useQuery({ queryKey: ['organization', 'business-hours'], queryFn: organizationService.businessHours, enabled: open });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [businessHoursId, setBusinessHoursId] = useState('');
  const [warning, setWarning] = useState(30);
  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [conditions, setConditions] = useState<ConditionTreeDto>({ all: [], any: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(policy?.name ?? '');
    setDescription(policy?.description ?? '');
    setIsDefault(policy?.isDefault ?? false);
    setBusinessHoursId(policy?.businessHoursId ?? '');
    setWarning(policy?.warningMinutesBefore ?? 30);
    setConditions(policy?.conditions ?? { all: [], any: [] });
    setTargets(policy
      ? policy.targets.map((t) => ({ priorityId: t.priorityId ?? '', firstResponseMinutes: t.firstResponseMinutes, resolutionMinutes: t.resolutionMinutes, useBusinessHours: t.useBusinessHours }))
      : [{ priorityId: '', firstResponseMinutes: 60, resolutionMinutes: 8 * 60, useBusinessHours: true }]);
    setError(null);
  }, [open, policy]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = slaPolicySchema.safeParse({
        name, description: description || null, isDefault, businessHoursId: businessHoursId || null, warningMinutesBefore: warning, conditions,
        targets: targets.map((t) => ({ ...t, priorityId: t.priorityId || null })),
        isActive: policy?.isActive ?? true, position: policy?.position ?? 0,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError('VALIDATION_ERROR', `${issue?.path.join('.') || 'policy'}: ${issue?.message ?? 'invalid'}`, 400);
      }
      return policy ? slaPoliciesService.update(policy.id, parsed.data) : slaPoliciesService.create(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
      toast.success(policy ? 'Policy updated' : 'Policy created');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save.'),
  });

  const setTarget = (index: number, patch: Partial<TargetDraft>) => setTargets(targets.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{policy ? 'Edit SLA policy' : 'New SLA policy'}</DialogTitle>
          <DialogDescription>Targets count working time on the chosen calendar unless a row says otherwise. The default policy catches every ticket no other policy claims.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="sla-name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Business hours" htmlFor="sla-hours" hint="Which calendar working time follows.">
              <Select value={businessHoursId} onChange={(e) => setBusinessHoursId(e.target.value)}>
                <option value="">Organization default</option>
                {calendars.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.timezone})</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto]">
            <Field label="Description" htmlFor="sla-desc"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="Warn (minutes before due)" htmlFor="sla-warn"><Input type="number" min={0} value={warning} onChange={(e) => setWarning(Number(e.target.value))} /></Field>
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" className="h-4 w-4 rounded border-input" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />Default policy</label>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Targets</h3>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-1">Priority</th><th>First response (min)</th><th>Resolution (min)</th><th>Business hours</th><th /></tr></thead>
              <tbody>
                {targets.map((target, index) => (
                  <tr key={index} className="border-t border-border">
                    <td className="py-1 pr-2">
                      <Select aria-label="Priority" value={target.priorityId} onChange={(e) => setTarget(index, { priorityId: e.target.value })}>
                        <option value="">Any other priority</option>
                        {priorities.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </td>
                    <td className="pr-2"><Input aria-label="First response minutes" type="number" min={1} value={target.firstResponseMinutes} onChange={(e) => setTarget(index, { firstResponseMinutes: Number(e.target.value) })} /></td>
                    <td className="pr-2"><Input aria-label="Resolution minutes" type="number" min={1} value={target.resolutionMinutes} onChange={(e) => setTarget(index, { resolutionMinutes: Number(e.target.value) })} /></td>
                    <td className="pr-2 text-center"><input aria-label="Count business hours" type="checkbox" className="h-4 w-4 rounded border-input" checked={target.useBusinessHours} onChange={(e) => setTarget(index, { useBusinessHours: e.target.checked })} /></td>
                    <td><Button variant="ghost" size="icon" aria-label="Remove target" onClick={() => setTargets(targets.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" aria-hidden /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button variant="outline" size="sm" onClick={() => setTargets([...targets, { priorityId: '', firstResponseMinutes: 60, resolutionMinutes: 8 * 60, useBusinessHours: true }])}><Plus className="h-4 w-4" aria-hidden />Add target</Button>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Applies to</h3>
            <ConditionEditor value={conditions} onChange={setConditions} />
          </section>
          {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{policy ? 'Save changes' : 'Create policy'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SlaPoliciesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.OPERATIONS_MANAGE);
  const [dialog, setDialog] = useState<{ open: boolean; policy: SlaPolicy | null }>({ open: false, policy: null });
  const policies = useQuery({ queryKey: ['sla-policies'], queryFn: slaPoliciesService.list });
  const remove = useMutation({
    mutationFn: (id: string) => slaPoliciesService.remove(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['sla-policies'] }); toast.success('Policy deleted'); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  return (
    <>
      <div className="flex justify-end">{manage ? <Button onClick={() => setDialog({ open: true, policy: null })}><Plus className="h-4 w-4" aria-hidden />New policy</Button> : null}</div>
      {policies.isPending ? <LoadingState /> : policies.isError ? (
        <ErrorState message="Unable to load SLA policies." onRetry={() => policies.refetch()} />
      ) : policies.data.length === 0 ? (
        <Card><EmptyState title="No SLA policies" description="Without a policy, tickets carry no due dates." action={manage ? <Button onClick={() => setDialog({ open: true, policy: null })}>New policy</Button> : null} /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {policies.data.map((policy) => (
            <Card key={policy.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>{policy.name}{policy.isDefault ? <Badge variant="outline" className="ml-2">Default</Badge> : null}{!policy.isActive ? <Badge className="ml-2">Disabled</Badge> : null}</CardTitle>
                    <CardDescription>{policy.description ?? `${policy.conditions.all.length + policy.conditions.any.length} condition(s)`} · {policy._count.tickets} ticket(s) · warns {policy.warningMinutesBefore}m before</CardDescription>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setDialog({ open: true, policy })}><Pencil className="h-4 w-4" aria-hidden /></Button>
                      <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void confirm({ title: `Delete "${policy.name}"?`, confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(policy.id) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="py-1">Priority</th><th>First response</th><th>Resolution</th><th>Clock</th></tr></thead>
                  <tbody>
                    {policy.targets.map((t) => (
                      <tr key={t.id} className="border-t border-border">
                        <td className="py-1">{t.priority?.name ?? 'Any other'}</td>
                        <td className="tabular-nums">{minutes(t.firstResponseMinutes)}</td>
                        <td className="tabular-nums">{minutes(t.resolutionMinutes)}</td>
                        <td className="text-muted-foreground">{t.useBusinessHours ? (policy.businessHours?.name ?? 'business hours') : 'wall clock'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <PolicyDialog open={dialog.open} onOpenChange={(open) => setDialog({ open, policy: open ? dialog.policy : null })} policy={dialog.policy} />
    </>
  );
}
