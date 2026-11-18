'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AUTOMATION_TRIGGERS, automationRuleSchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { automationRulesService } from '@/services/operations.service';
import type { AutomationRule, ConditionTreeDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConditionEditor } from './condition-editor';
import { ActionEditor, type ActionDraft } from './action-editor';

export const TRIGGER_LABELS: Record<string, string> = {
  TICKET_CREATED: 'Ticket created',
  TICKET_UPDATED: 'Ticket updated',
  TICKET_ASSIGNED: 'Ticket assigned',
  STATUS_CHANGED: 'Status changed',
  PRIORITY_CHANGED: 'Priority changed',
  CUSTOMER_REPLIED: 'Customer replied',
  AGENT_REPLIED: 'Agent replied',
  SLA_WARNING: 'SLA about to breach',
  SLA_BREACHED: 'SLA breached',
};

const ESCALATION_TRIGGERS = ['SLA_WARNING', 'SLA_BREACHED'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: AutomationRule | null;
  /** Escalation dialogs only offer the SLA triggers. */
  escalation?: boolean;
}

export function RuleFormDialog({ open, onOpenChange, rule, escalation = false }: Props) {
  const queryClient = useQueryClient();
  const triggers = AUTOMATION_TRIGGERS.filter((t) => (escalation ? ESCALATION_TRIGGERS.includes(t) : !ESCALATION_TRIGGERS.includes(t)));

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState<string>(triggers[0] ?? 'TICKET_CREATED');
  const [conditions, setConditions] = useState<ConditionTreeDto>({ all: [], any: [] });
  const [actions, setActions] = useState<ActionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(rule?.name ?? '');
    setDescription(rule?.description ?? '');
    setTrigger(rule?.trigger ?? triggers[0] ?? 'TICKET_CREATED');
    setConditions(rule?.conditions ?? { all: [], any: [] });
    setActions((rule?.actions as ActionDraft[] | undefined) ?? []);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  const save = useMutation({
    mutationFn: async () => {
      // Validated with the same schema the API uses, so the error is the same one.
      const parsed = automationRuleSchema.safeParse({ name, description: description || null, trigger, conditions, actions });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError('VALIDATION_ERROR', `${issue?.path.join('.') || 'rule'}: ${issue?.message ?? 'invalid'}`, 400);
      }
      return rule ? automationRulesService.update(rule.id, parsed.data) : automationRulesService.create(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['automation-rules'] });
      toast.success(rule ? 'Rule updated' : 'Rule created');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save the rule.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : escalation ? 'New escalation' : 'New workflow rule'}</DialogTitle>
          <DialogDescription>
            {escalation
              ? 'Runs when an SLA target is about to be, or has been, missed.'
              : 'When the trigger fires and the conditions hold, the actions run in order.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
            <Field label="Name" htmlFor="rule-name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Trigger" htmlFor="rule-trigger" required>
              <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                {triggers.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description" htmlFor="rule-description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <section className="space-y-2">
            <h3 className="text-base font-semibold">Conditions</h3>
            <ConditionEditor value={conditions} onChange={setConditions} />
          </section>
          <section className="space-y-2">
            <h3 className="text-base font-semibold">Actions</h3>
            <ActionEditor value={actions} onChange={setActions} />
          </section>
          {error ? <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" loading={save.isPending} onClick={() => save.mutate()}>{rule ? 'Save changes' : 'Create rule'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
