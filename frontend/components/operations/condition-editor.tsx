'use client';

import { Plus, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { CONDITION_FIELDS, CONDITION_OPERATORS, TICKET_SOURCES } from '@digisoft/shared';
import { ticketConfigService } from '@/services/tickets.service';
import { departmentsService } from '@/services/settings.service';
import type { ConditionLeafDto, ConditionTreeDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';

const FIELD_LABELS: Record<(typeof CONDITION_FIELDS)[number], string> = {
  statusId: 'Status',
  priorityId: 'Priority',
  departmentId: 'Department',
  categoryId: 'Category',
  assignedAgentId: 'Assigned agent',
  contactId: 'Contact',
  accountId: 'Account',
  source: 'Source',
  tagIds: 'Tags',
  subject: 'Subject',
  description: 'Description',
  contactIsVip: 'Contact is VIP',
  isAssigned: 'Is assigned',
  priorityWeight: 'Priority weight',
};

const OP_LABELS: Record<(typeof CONDITION_OPERATORS)[number], string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'contains',
  not_contains: 'does not contain',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty']);

/** Fields whose value is picked from the organization's own configuration. */
function useOptions() {
  const statuses = useQuery({ queryKey: ['ticket-statuses'], queryFn: ticketConfigService.statuses });
  const priorities = useQuery({ queryKey: ['ticket-priorities'], queryFn: ticketConfigService.priorities });
  const categories = useQuery({ queryKey: ['ticket-categories'], queryFn: ticketConfigService.categories });
  const tags = useQuery({ queryKey: ['tags'], queryFn: ticketConfigService.tags });
  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list });
  return {
    statusId: statuses.data?.map((s) => ({ id: s.id, name: s.name })) ?? [],
    priorityId: priorities.data?.map((p) => ({ id: p.id, name: p.name })) ?? [],
    categoryId: categories.data?.map((c) => ({ id: c.id, name: c.name })) ?? [],
    tagIds: tags.data?.map((t) => ({ id: t.id, name: t.name })) ?? [],
    departmentId: departments.data?.map((d) => ({ id: d.id, name: d.name })) ?? [],
    source: TICKET_SOURCES.map((s) => ({ id: s, name: s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ') })),
  } as Record<string, { id: string; name: string }[]>;
}

function LeafRow({ leaf, onChange, onRemove, options }: { leaf: ConditionLeafDto; onChange: (leaf: ConditionLeafDto) => void; onRemove: () => void; options: Record<string, { id: string; name: string }[]> }) {
  const picklist = options[leaf.field];
  const boolean = leaf.field === 'contactIsVip' || leaf.field === 'isAssigned';
  const numeric = leaf.field === 'priorityWeight';
  const multi = leaf.op === 'in' || leaf.op === 'not_in' || (leaf.field === 'tagIds' && (leaf.op === 'contains' || leaf.op === 'not_contains'));

  const valueControl = () => {
    if (NO_VALUE_OPS.has(leaf.op)) return null;
    if (boolean) {
      return (
        <Select aria-label="Value" value={String(leaf.value ?? 'true')} onChange={(e) => onChange({ ...leaf, value: e.target.value === 'true' })}>
          <option value="true">yes</option>
          <option value="false">no</option>
        </Select>
      );
    }
    if (numeric) {
      return <Input aria-label="Value" type="number" value={String(leaf.value ?? '')} onChange={(e) => onChange({ ...leaf, value: Number(e.target.value) })} />;
    }
    if (picklist) {
      if (multi) {
        const selected = Array.isArray(leaf.value) ? leaf.value : [];
        return (
          <div className="flex flex-wrap gap-1">
            {picklist.map((option) => {
              const on = selected.includes(option.id);
              return (
                <button key={option.id} type="button" aria-pressed={on} onClick={() => onChange({ ...leaf, value: on ? selected.filter((id) => id !== option.id) : [...selected, option.id] })}
                  className={`rounded border px-1.5 py-0.5 text-xs ${on ? 'border-foreground' : 'border-border text-muted-foreground'}`}>
                  {option.name}
                </button>
              );
            })}
          </div>
        );
      }
      return (
        <Select aria-label="Value" value={String(leaf.value ?? '')} onChange={(e) => onChange({ ...leaf, value: e.target.value })}>
          <option value="">Choose…</option>
          {picklist.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </Select>
      );
    }
    return <Input aria-label="Value" value={String(leaf.value ?? '')} onChange={(e) => onChange({ ...leaf, value: e.target.value })} />;
  };

  return (
    <li className="grid gap-2 sm:grid-cols-[10rem_9rem_1fr_2rem]">
      <Select aria-label="Field" value={leaf.field} onChange={(e) => onChange({ field: e.target.value, op: 'eq', value: undefined })}>
        {CONDITION_FIELDS.map((field) => <option key={field} value={field}>{FIELD_LABELS[field]}</option>)}
      </Select>
      <Select aria-label="Operator" value={leaf.op} onChange={(e) => onChange({ ...leaf, op: e.target.value, value: NO_VALUE_OPS.has(e.target.value) ? undefined : leaf.value })}>
        {CONDITION_OPERATORS.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
      </Select>
      <div>{valueControl()}</div>
      <Button type="button" variant="ghost" size="icon" aria-label="Remove condition" onClick={onRemove}><X className="h-4 w-4" aria-hidden /></Button>
    </li>
  );
}

/** Edits the shared `{ all, any }` condition tree. */
export function ConditionEditor({ value, onChange }: { value: ConditionTreeDto; onChange: (tree: ConditionTreeDto) => void }) {
  const options = useOptions();
  const group = (key: 'all' | 'any', title: string, hint: string) => (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {value[key].length > 0 ? (
        <ul className="space-y-2">
          {value[key].map((leaf, index) => (
            <LeafRow key={index} leaf={leaf} options={options}
              onChange={(next) => onChange({ ...value, [key]: value[key].map((item, i) => (i === index ? next : item)) })}
              onRemove={() => onChange({ ...value, [key]: value[key].filter((_, i) => i !== index) })} />
          ))}
        </ul>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, [key]: [...value[key], { field: 'priorityId', op: 'eq', value: '' }] })}>
        <Plus className="h-4 w-4" aria-hidden />Add condition
      </Button>
    </fieldset>
  );
  return (
    <div className="space-y-3">
      {group('all', 'All of', 'Every condition here must hold. Leave both groups empty to match every ticket.')}
      {group('any', 'Any of', 'At least one of these must hold.')}
    </div>
  );
}
