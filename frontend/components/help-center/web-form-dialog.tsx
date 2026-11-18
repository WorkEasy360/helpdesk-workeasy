'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  WEB_FORM_FIELD_TARGETS,
  WEB_FORM_FIELD_TYPES,
  slugify,
  type WebFormInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { helpCenterService } from '@/services/help-center.service';
import { departmentsService } from '@/services/settings.service';
import { ticketConfigService } from '@/services/tickets.service';
import type { WebForm, WebFormFieldDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';

const TARGET_LABELS: Record<string, string> = {
  subject: 'Ticket subject',
  description: 'Ticket description',
  name: 'Customer name',
  email: 'Customer email',
  phone: 'Customer phone',
  custom: 'Custom field',
};

const emptyField: WebFormFieldDto = {
  key: '',
  label: '',
  type: 'TEXT',
  required: false,
  placeholder: null,
  helpText: null,
  options: [],
  mapsTo: 'custom',
};

interface Draft {
  name: string;
  slug: string;
  description: string;
  departmentId: string;
  categoryId: string;
  priorityId: string;
  submitLabel: string;
  successMessage: string;
  requireLogin: boolean;
  isActive: boolean;
  fields: WebFormFieldDto[];
}

const emptyDraft: Draft = {
  name: '',
  slug: '',
  description: '',
  departmentId: '',
  categoryId: '',
  priorityId: '',
  submitLabel: 'Submit request',
  successMessage: 'Thanks — we have received your request.',
  requireLogin: false,
  isActive: true,
  fields: [
    { ...emptyField, key: 'subject', label: 'Subject', type: 'TEXT', required: true, mapsTo: 'subject' },
    {
      ...emptyField,
      key: 'description',
      label: 'How can we help?',
      type: 'TEXTAREA',
      required: true,
      mapsTo: 'description',
    },
  ],
};

function toDraft(form: WebForm): Draft {
  return {
    name: form.name,
    slug: form.slug,
    description: form.description ?? '',
    departmentId: form.department?.id ?? '',
    categoryId: form.category?.id ?? '',
    priorityId: form.priority?.id ?? '',
    submitLabel: form.submitLabel,
    successMessage: form.successMessage,
    requireLogin: form.requireLogin,
    isActive: form.isActive,
    fields: form.fields,
  };
}

/** Field-by-field builder. A form always maps one field to the ticket description. */
export function WebFormDialog({
  form,
  open,
  onOpenChange,
}: {
  form: WebForm | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(form ? toDraft(form) : emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(form ? toDraft(form) : emptyDraft);
      setError(null);
    }
  }, [open, form]);

  const departments = useQuery({ queryKey: ['departments'], queryFn: departmentsService.list, enabled: open });
  const categories = useQuery({ queryKey: ['ticket-categories'], queryFn: ticketConfigService.categories, enabled: open });
  const priorities = useQuery({ queryKey: ['ticket-priorities'], queryFn: ticketConfigService.priorities, enabled: open });

  const save = useMutation({
    mutationFn: (values: Draft) => {
      const payload: WebFormInput = {
        name: values.name,
        slug: values.slug ? slugify(values.slug) : slugify(values.name),
        description: values.description || null,
        departmentId: values.departmentId || null,
        categoryId: values.categoryId || null,
        priorityId: values.priorityId || null,
        submitLabel: values.submitLabel,
        successMessage: values.successMessage,
        requireLogin: values.requireLogin,
        isActive: values.isActive,
        fields: values.fields.map((field) => ({
          ...field,
          key: field.key || slugify(field.label).replace(/-/g, '_') || 'field',
          placeholder: field.placeholder || null,
          helpText: field.helpText || null,
        })),
      };
      return form ? helpCenterService.updateForm(form.id, payload) : helpCenterService.createForm(payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['web-forms'] });
      toast.success('Form saved');
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save the form.'),
  });

  const updateField = (index: number, patch: Partial<WebFormFieldDto>) => {
    setDraft({
      ...draft,
      fields: draft.fields.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    });
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const next = [...draft.fields];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target] as WebFormFieldDto, next[index] as WebFormFieldDto];
    setDraft({ ...draft, fields: next });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form ? 'Edit form' : 'New web form'}</DialogTitle>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.name.trim()) {
              setError('Give the form a name.');
              return;
            }
            save.mutate(draft);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="form-name" required>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="Address" htmlFor="form-slug" hint="Leave blank to use the name.">
              <Input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} />
            </Field>
          </div>
          <Field label="Description" htmlFor="form-description">
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Route to department" htmlFor="form-department">
              <Select
                value={draft.departmentId}
                onChange={(event) => setDraft({ ...draft, departmentId: event.target.value })}
              >
                <option value="">Use assignment rules</option>
                {(departments.data ?? []).map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="form-category">
              <Select
                value={draft.categoryId}
                onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
              >
                <option value="">None</option>
                {(categories.data ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="form-priority">
              <Select
                value={draft.priorityId}
                onChange={(event) => setDraft({ ...draft, priorityId: event.target.value })}
              >
                <option value="">Default</option>
                {(priorities.data ?? []).map((priority) => (
                  <option key={priority.id} value={priority.id}>
                    {priority.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-medium">Fields</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft({ ...draft, fields: [...draft.fields, { ...emptyField }] })}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add field
              </Button>
            </div>

            {draft.fields.map((field, index) => (
              <div key={index} className="space-y-3 rounded-md border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Label" htmlFor={`field-label-${index}`} required>
                    <Input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} />
                  </Field>
                  <Field label="Key" htmlFor={`field-key-${index}`} hint="Stored on the ticket for custom fields.">
                    <Input value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} />
                  </Field>
                  <Field label="Type" htmlFor={`field-type-${index}`}>
                    <Select
                      value={field.type}
                      onChange={(event) => updateField(index, { type: event.target.value as WebFormFieldDto['type'] })}
                    >
                      {WEB_FORM_FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type.charAt(0) + type.slice(1).toLowerCase()}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Goes to" htmlFor={`field-target-${index}`}>
                    <Select
                      value={field.mapsTo}
                      onChange={(event) =>
                        updateField(index, { mapsTo: event.target.value as WebFormFieldDto['mapsTo'] })
                      }
                    >
                      {WEB_FORM_FIELD_TARGETS.map((target) => (
                        <option key={target} value={target}>
                          {TARGET_LABELS[target]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                {field.type === 'SELECT' ? (
                  <Field label="Options" htmlFor={`field-options-${index}`} hint="Comma separated.">
                    <Input
                      value={field.options.join(', ')}
                      onChange={(event) =>
                        updateField(index, {
                          options: event.target.value
                            .split(',')
                            .map((option) => option.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </Field>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-base">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={field.required}
                      onChange={(event) => updateField(index, { required: event.target.checked })}
                    />
                    Required
                  </label>
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Move field up"
                      onClick={() => moveField(index, -1)}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Move field down"
                      onClick={() => moveField(index, 1)}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove field"
                      onClick={() =>
                        setDraft({ ...draft, fields: draft.fields.filter((_, position) => position !== index) })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Submit button" htmlFor="form-submit-label">
              <Input
                value={draft.submitLabel}
                onChange={(event) => setDraft({ ...draft, submitLabel: event.target.value })}
              />
            </Field>
            <Field label="Message after submitting" htmlFor="form-success">
              <Input
                value={draft.successMessage}
                onChange={(event) => setDraft({ ...draft, successMessage: event.target.value })}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={draft.requireLogin}
                onChange={(event) => setDraft({ ...draft, requireLogin: event.target.checked })}
              />
              Only signed-in customers can use it
            </label>
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={draft.isActive}
                onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
              />
              Active
            </label>
          </div>

          {error ? <p role="alert" className="text-base text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save form
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
