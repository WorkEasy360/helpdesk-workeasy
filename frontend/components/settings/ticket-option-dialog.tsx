'use client';

import { useState } from 'react';
import type { TicketPriorityConfig, TicketStatusConfig } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface StatusValues {
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isResolved: boolean;
  isClosed: boolean;
  pausesSla: boolean;
}

export interface PriorityValues {
  name: string;
  color: string;
  weight: number;
  position: number;
  isDefault: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function Flag({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  ) : null;
}

/**
 * Creates or edits a ticket status with all of its behaviour flags. The whole record is
 * always submitted, never a partial patch, so no flag is silently reset.
 */
export function StatusDialog({
  open,
  status,
  nextPosition,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  /** The status being edited; null to create one. */
  status: TicketStatusConfig | null;
  nextPosition: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: StatusValues) => Promise<void>;
}) {
  // Seeded once per mount: the parent remounts the dialog (via `key`) for each record,
  // so a background refetch cannot overwrite what the admin is typing.
  const [values, setValues] = useState<StatusValues>(() =>
    status
      ? {
          name: status.name,
          color: status.color,
          position: status.position,
          isDefault: status.isDefault,
          isResolved: status.isResolved,
          isClosed: status.isClosed,
          pausesSla: status.pausesSla,
        }
      : {
          name: '',
          color: '#64748b',
          position: nextPosition,
          isDefault: false,
          isResolved: false,
          isClosed: false,
          pausesSla: false,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof StatusValues>(key: K, value: StatusValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!values.name.trim()) {
      setError('Give the status a name.');
      return;
    }
    if (!HEX.test(values.color)) {
      setError('Use a hex colour such as #2563eb.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...values, name: values.name.trim() });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save the status.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{status ? `Edit ${status.name}` : 'New status'}</DialogTitle>
          <DialogDescription>Behaviour comes from the flags, not the name.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Name" htmlFor="status-name" required>
                <Input
                  autoFocus
                  value={values.name}
                  maxLength={60}
                  onChange={(event) => set('name', event.target.value)}
                />
              </Field>
            </div>
            <div>
              <label htmlFor="status-color" className="sr-only">
                Colour
              </label>
              <input
                id="status-color"
                type="color"
                value={values.color}
                onChange={(event) => set('color', event.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Flag
              id="status-default"
              label="Default"
              hint="New tickets start in this status. Only one status can be the default."
              checked={values.isDefault}
              // Moving the default is done by making another status the default.
              disabled={status?.isDefault ?? false}
              onChange={(checked) => set('isDefault', checked)}
            />
            <Flag
              id="status-resolved"
              label="Resolves the ticket"
              hint="Moving here asks for a resolution note and stops the resolution SLA."
              checked={values.isResolved}
              onChange={(checked) => set('isResolved', checked)}
            />
            <Flag
              id="status-closed"
              label="Closes the ticket"
              hint="A closed ticket is finished; a customer reply opens a new one or reopens it."
              checked={values.isClosed}
              onChange={(checked) => set('isClosed', checked)}
            />
            <Flag
              id="status-pauses"
              label="Pauses the SLA"
              hint="Stops the SLA clock while the ticket waits on someone else."
              checked={values.pausesSla}
              onChange={(checked) => set('pausesSla', checked)}
            />
          </div>

          <ErrorLine message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {status ? 'Save changes' : 'Create status'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Creates or edits a ticket priority, always submitting the whole record. */
export function PriorityDialog({
  open,
  priority,
  nextPosition,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  priority: TicketPriorityConfig | null;
  nextPosition: number;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: PriorityValues) => Promise<void>;
}) {
  const [values, setValues] = useState<PriorityValues>(() =>
    priority
      ? {
          name: priority.name,
          color: priority.color,
          weight: priority.weight,
          position: priority.position,
          isDefault: priority.isDefault,
        }
      : { name: '', color: '#64748b', weight: 50, position: nextPosition, isDefault: false },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof PriorityValues>(key: K, value: PriorityValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!values.name.trim()) {
      setError('Give the priority a name.');
      return;
    }
    if (!Number.isInteger(values.weight) || values.weight < 0 || values.weight > 1000) {
      setError('Weight must be a whole number between 0 and 1000.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...values, name: values.name.trim() });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save the priority.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{priority ? `Edit ${priority.name}` : 'New priority'}</DialogTitle>
          <DialogDescription>
            Weight decides which priority wins when automation compares two tickets.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Name" htmlFor="priority-name" required>
                <Input
                  autoFocus
                  value={values.name}
                  maxLength={60}
                  onChange={(event) => set('name', event.target.value)}
                />
              </Field>
            </div>
            <div>
              <label htmlFor="priority-color" className="sr-only">
                Colour
              </label>
              <input
                id="priority-color"
                type="color"
                value={values.color}
                onChange={(event) => set('color', event.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background"
              />
            </div>
          </div>
          <Field label="Weight" htmlFor="priority-weight" hint="0–1000. Higher is more urgent.">
            <Input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={Number.isNaN(values.weight) ? '' : values.weight}
              onChange={(event) => set('weight', event.target.valueAsNumber)}
            />
          </Field>
          <Flag
            id="priority-default"
            label="Default"
            hint="New tickets get this priority. Only one priority can be the default."
            checked={values.isDefault}
            disabled={priority?.isDefault ?? false}
            onChange={(checked) => set('isDefault', checked)}
          />
          <ErrorLine message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {priority ? 'Save changes' : 'Create priority'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
