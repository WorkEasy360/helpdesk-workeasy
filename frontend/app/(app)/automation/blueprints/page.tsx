'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, TRANSITION_REQUIRED_FIELDS, blueprintSchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { blueprintsService } from '@/services/operations.service';
import { ticketConfigService } from '@/services/tickets.service';
import { rolesService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import type { Blueprint, ConditionTreeDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ConditionEditor } from '@/components/operations/condition-editor';

interface TransitionDraft { name: string; fromStatusId: string; toStatusId: string; requiredFields: string[]; allowedRoleIds: string[] }

const FIELD_LABELS: Record<string, string> = {
  resolutionNote: 'Resolution note', assignedAgentId: 'Assignee', departmentId: 'Department', categoryId: 'Category', contactId: 'Contact', tags: 'At least one tag',
};

function BlueprintDialog({ open, onOpenChange, blueprint }: { open: boolean; onOpenChange: (o: boolean) => void; blueprint: Blueprint | null }) {
  const queryClient = useQueryClient();
  const statuses = useQuery({ queryKey: ['ticket-statuses'], queryFn: ticketConfigService.statuses, enabled: open });
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesService.list, enabled: open });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [conditions, setConditions] = useState<ConditionTreeDto>({ all: [], any: [] });
  const [transitions, setTransitions] = useState<TransitionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(blueprint?.name ?? '');
    setDescription(blueprint?.description ?? '');
    setConditions(blueprint?.conditions ?? { all: [], any: [] });
    setTransitions(blueprint ? blueprint.transitions.map((t) => ({ name: t.name, fromStatusId: t.fromStatusId ?? '', toStatusId: t.toStatusId, requiredFields: t.requiredFields, allowedRoleIds: t.allowedRoleIds })) : [{ name: 'Start work', fromStatusId: '', toStatusId: '', requiredFields: [], allowedRoleIds: [] }]);
    setError(null);
  }, [open, blueprint]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = blueprintSchema.safeParse({
        name, description: description || null, conditions, isActive: blueprint?.isActive ?? true, position: blueprint?.position ?? 0,
        transitions: transitions.map((t, position) => ({ ...t, fromStatusId: t.fromStatusId || null, position })),
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError('VALIDATION_ERROR', `${issue?.path.join('.') || 'blueprint'}: ${issue?.message ?? 'invalid'}`, 400);
      }
      return blueprint ? blueprintsService.update(blueprint.id, parsed.data) : blueprintsService.create(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['blueprints'] });
      toast.success(blueprint ? 'Blueprint updated' : 'Blueprint created');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save.'),
  });

  const set = (index: number, patch: Partial<TransitionDraft>) => setTransitions(transitions.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  const toggleIn = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{blueprint ? 'Edit blueprint' : 'New blueprint'}</DialogTitle>
          <DialogDescription>A blueprint narrows which status moves are possible. Tickets it does not cover keep the free-form flow.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="bp-name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Description" htmlFor="bp-desc"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </div>

          <section className="space-y-2">
            <h3 className="text-base font-semibold">Transitions</h3>
            <ul className="space-y-3">
              {transitions.map((t, index) => (
                <li key={index} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_1fr_2rem] sm:items-center">
                    <Input aria-label="Transition name" value={t.name} onChange={(e) => set(index, { name: e.target.value })} placeholder="Name" />
                    <Select aria-label="From status" value={t.fromStatusId} onChange={(e) => set(index, { fromStatusId: e.target.value })}>
                      <option value="">Any status</option>
                      {statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
                    <Select aria-label="To status" value={t.toStatusId} onChange={(e) => set(index, { toStatusId: e.target.value })}>
                      <option value="">Choose…</option>
                      {statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    <Button variant="ghost" size="icon" aria-label="Remove transition" onClick={() => setTransitions(transitions.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="mr-1 text-muted-foreground">Requires:</span>
                    {TRANSITION_REQUIRED_FIELDS.map((field) => (
                      <button key={field} type="button" aria-pressed={t.requiredFields.includes(field)} onClick={() => set(index, { requiredFields: toggleIn(t.requiredFields, field) })}
                        className={`rounded border px-1.5 py-0.5 ${t.requiredFields.includes(field) ? 'border-foreground' : 'border-border text-muted-foreground'}`}>{FIELD_LABELS[field]}</button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="mr-1 text-muted-foreground">Allowed roles (empty = anyone):</span>
                    {roles.data?.map((role) => (
                      <button key={role.id} type="button" aria-pressed={t.allowedRoleIds.includes(role.id)} onClick={() => set(index, { allowedRoleIds: toggleIn(t.allowedRoleIds, role.id) })}
                        className={`rounded border px-1.5 py-0.5 ${t.allowedRoleIds.includes(role.id) ? 'border-foreground' : 'border-border text-muted-foreground'}`}>{role.name}</button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <Button variant="outline" size="sm" onClick={() => setTransitions([...transitions, { name: '', fromStatusId: '', toStatusId: '', requiredFields: [], allowedRoleIds: [] }])}><Plus className="h-4 w-4" aria-hidden />Add transition</Button>
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold">Governs tickets where</h3>
            <ConditionEditor value={conditions} onChange={setConditions} />
          </section>
          {error ? <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>{blueprint ? 'Save changes' : 'Create blueprint'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BlueprintsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.OPERATIONS_MANAGE);
  const [dialog, setDialog] = useState<{ open: boolean; blueprint: Blueprint | null }>({ open: false, blueprint: null });
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: blueprintsService.list });
  const remove = useMutation({
    mutationFn: (id: string) => blueprintsService.remove(id),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['blueprints'] }); toast.success('Blueprint deleted'); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  return (
    <>
      <div className="flex justify-end">{manage ? <Button onClick={() => setDialog({ open: true, blueprint: null })}><Plus className="h-4 w-4" aria-hidden />New blueprint</Button> : null}</div>
      {blueprints.isPending ? <LoadingState /> : blueprints.isError ? (
        <ErrorState message="Unable to load blueprints." onRetry={() => blueprints.refetch()} />
      ) : blueprints.data.length === 0 ? (
        <Card><EmptyState title="No blueprints" description="Agents can move tickets between any statuses until a blueprint says otherwise." action={manage ? <Button onClick={() => setDialog({ open: true, blueprint: null })}>New blueprint</Button> : null} /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {blueprints.data.map((bp) => (
            <Card key={bp.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle>{bp.name}{!bp.isActive ? <Badge className="ml-2">Disabled</Badge> : null}</CardTitle>
                    <CardDescription>{bp.description ?? `${bp.conditions.all.length + bp.conditions.any.length} condition(s)`}</CardDescription>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setDialog({ open: true, blueprint: bp })}><Pencil className="h-4 w-4" aria-hidden /></Button>
                      <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => void confirm({ title: `Delete "${bp.name}"?`, confirmLabel: 'Delete', onConfirm: () => remove.mutateAsync(bp.id) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent>
                <ol className="space-y-1.5 text-base">
                  {bp.transitions.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground">{t.fromStatus?.name ?? 'any'}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                      <span style={{ color: t.toStatus.color }}>{t.toStatus.name}</span>
                      {t.requiredFields.length > 0 ? <span className="text-xs text-muted-foreground">· needs {t.requiredFields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}</span> : null}
                      {t.allowedRoleIds.length > 0 ? <Badge variant="outline">role-restricted</Badge> : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <BlueprintDialog open={dialog.open} onOpenChange={(open) => setDialog({ open, blueprint: open ? dialog.blueprint : null })} blueprint={dialog.blueprint} />
    </>
  );
}
