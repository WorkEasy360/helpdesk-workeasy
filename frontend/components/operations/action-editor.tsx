'use client';

import { Plus, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ticketConfigService } from '@/services/tickets.service';
import { departmentsService, usersService } from '@/services/settings.service';
import { slaPoliciesService } from '@/services/operations.service';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';

export type ActionDraft = Record<string, unknown> & { type: string };

const TYPES: { value: string; label: string }[] = [
  { value: 'assign_agent', label: 'Assign to agent' },
  { value: 'assign_department', label: 'Route to department' },
  { value: 'unassign', label: 'Unassign' },
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'add_tag', label: 'Add tag' },
  { value: 'remove_tag', label: 'Remove tag' },
  { value: 'apply_sla', label: 'Apply SLA policy' },
  { value: 'notify_assignee', label: 'Notify assignee' },
  { value: 'notify_department', label: 'Notify department' },
  { value: 'notify_users', label: 'Notify specific users' },
  { value: 'send_email', label: 'Send email' },
  { value: 'add_internal_note', label: 'Add internal note' },
  { value: 'create_task', label: 'Create task' },
];

const PLACEHOLDER_HINT = 'Placeholders: {{ticket.number}} {{ticket.subject}} {{ticket.status}} {{ticket.priority}} {{contact.name}} {{assignee.name}}';

function defaults(type: string): ActionDraft {
  switch (type) {
    case 'notify_assignee':
    case 'notify_department':
      return { type, message: 'Attention needed on {{ticket.number}}' };
    case 'notify_users':
      return { type, userIds: [], message: 'Attention needed on {{ticket.number}}' };
    case 'send_email':
      return { type, to: 'contact', subject: 'Update on {{ticket.number}}', body: 'Hello {{contact.name}},' };
    case 'add_internal_note':
      return { type, body: '' };
    case 'create_task':
      return { type, subject: 'Follow up on {{ticket.number}}', assignTo: 'assignee', dueInHours: 24 };
    default:
      return { type };
  }
}

function ActionRow({ action, onChange, onRemove }: { action: ActionDraft; onChange: (a: ActionDraft) => void; onRemove: () => void }) {
  const statuses = useQuery({ queryKey: ['ticket-statuses'], queryFn: ticketConfigService.statuses });
  const priorities = useQuery({ queryKey: ['ticket-priorities'], queryFn: ticketConfigService.priorities });
  const tags = useQuery({ queryKey: ['tags'], queryFn: ticketConfigService.tags });
  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list });
  const agents = useQuery({ queryKey: ['users', 'assignable'], queryFn: () => usersService.list({ page: 1, pageSize: 100, isActive: true }) });
  const policies = useQuery({ queryKey: ['sla-policies'], queryFn: slaPoliciesService.list });
  const set = (patch: Record<string, unknown>) => onChange({ ...action, ...patch });
  const str = (key: string) => String(action[key] ?? '');

  const pick = (key: string, items: { id: string; name: string }[] | undefined, label: string) => (
    <Select aria-label={label} value={str(key)} onChange={(e) => set({ [key]: e.target.value })}>
      <option value="">Choose…</option>
      {items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </Select>
  );
  const agentItems = agents.data?.items.map((a) => ({ id: a.id, name: `${a.firstName} ${a.lastName}` }));

  const body = () => {
    switch (action.type) {
      case 'assign_agent': return pick('agentId', agentItems, 'Agent');
      case 'assign_department': return pick('departmentId', departments.data, 'Department');
      case 'set_priority': return pick('priorityId', priorities.data, 'Priority');
      case 'set_status': return pick('statusId', statuses.data, 'Status');
      case 'add_tag':
      case 'remove_tag': return pick('tagId', tags.data, 'Tag');
      case 'apply_sla': return pick('slaPolicyId', policies.data, 'SLA policy');
      case 'notify_assignee':
      case 'notify_department':
        return <Input aria-label="Message" value={str('message')} onChange={(e) => set({ message: e.target.value })} placeholder="Message" />;
      case 'notify_users': {
        const selected = Array.isArray(action.userIds) ? (action.userIds as string[]) : [];
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {agentItems?.map((agent) => {
                const on = selected.includes(agent.id);
                return <button key={agent.id} type="button" aria-pressed={on} onClick={() => set({ userIds: on ? selected.filter((id) => id !== agent.id) : [...selected, agent.id] })}
                  className={`rounded border px-1.5 py-0.5 text-xs ${on ? 'border-foreground' : 'border-border text-muted-foreground'}`}>{agent.name}</button>;
              })}
            </div>
            <Input aria-label="Message" value={str('message')} onChange={(e) => set({ message: e.target.value })} placeholder="Message" />
          </div>
        );
      }
      case 'send_email':
        return (
          <div className="space-y-2">
            <Select aria-label="Recipient" value={Array.isArray(action.to) ? 'custom' : str('to')} onChange={(e) => set({ to: e.target.value === 'custom' ? [] : e.target.value })}>
              <option value="contact">The contact</option>
              <option value="assignee">The assignee</option>
              <option value="custom">Specific addresses</option>
            </Select>
            {Array.isArray(action.to) ? (
              <Input aria-label="Addresses" placeholder="a@example.com, b@example.com" value={(action.to as string[]).join(', ')}
                onChange={(e) => set({ to: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            ) : null}
            <Input aria-label="Subject" value={str('subject')} onChange={(e) => set({ subject: e.target.value })} placeholder="Subject" />
            <Textarea aria-label="Body" rows={3} value={str('body')} onChange={(e) => set({ body: e.target.value })} placeholder="Body" />
          </div>
        );
      case 'add_internal_note':
        return <Textarea aria-label="Note" rows={2} value={str('body')} onChange={(e) => set({ body: e.target.value })} placeholder="Note for the team" />;
      case 'create_task':
        return (
          <div className="grid gap-2 sm:grid-cols-[1fr_10rem_6rem]">
            <Input aria-label="Task subject" value={str('subject')} onChange={(e) => set({ subject: e.target.value })} placeholder="Subject" />
            <Select aria-label="Assign task to" value={str('assignTo')} onChange={(e) => set({ assignTo: e.target.value || undefined })}>
              <option value="assignee">Ticket assignee</option>
              <option value="">Unassigned</option>
              {agentItems?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Input aria-label="Due in hours" type="number" min={1} value={str('dueInHours')} onChange={(e) => set({ dueInHours: Number(e.target.value) || undefined })} placeholder="Hours" />
          </div>
        );
      default: return null;
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Select aria-label="Action" value={action.type} onChange={(e) => onChange(defaults(e.target.value))} className="max-w-xs">
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Button type="button" variant="ghost" size="icon" className="ml-auto" aria-label="Remove action" onClick={onRemove}><X className="h-4 w-4" aria-hidden /></Button>
      </div>
      {body()}
    </li>
  );
}

export function ActionEditor({ value, onChange }: { value: ActionDraft[]; onChange: (actions: ActionDraft[]) => void }) {
  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="space-y-2">
          {value.map((action, index) => (
            <ActionRow key={index} action={action}
              onChange={(next) => onChange(value.map((item, i) => (i === index ? next : item)))}
              onRemove={() => onChange(value.filter((_, i) => i !== index))} />
          ))}
        </ul>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, defaults('set_priority')])}><Plus className="h-4 w-4" aria-hidden />Add action</Button>
      <p className="text-xs text-muted-foreground">{PLACEHOLDER_HINT}</p>
    </div>
  );
}
