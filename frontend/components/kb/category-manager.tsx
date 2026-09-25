'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CONTENT_VISIBILITIES } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { kbService } from '@/services/kb.service';
import type { KbCategory } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState, LoadingState } from '@/components/ui/states';

const VISIBILITY_LABELS: Record<string, string> = {
  PUBLIC: 'Anyone',
  PORTAL_USERS: 'Signed-in customers',
  AGENTS_ONLY: 'Agents only',
};

interface Draft {
  id: string | null;
  name: string;
  description: string;
  visibility: string;
  position: number;
}

const emptyDraft: Draft = { id: null, name: '', description: '', visibility: 'PUBLIC', position: 0 };

/** Category list and editor for the knowledge base, shown as a dialog from the list page. */
export function CategoryManager({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ['kb-categories'], queryFn: kbService.categories, enabled: open });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['kb-categories'] });
    await queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
  };

  const save = useMutation({
    mutationFn: (values: Draft) => {
      const payload = {
        name: values.name,
        description: values.description || null,
        visibility: values.visibility as 'PUBLIC',
        position: values.position,
      };
      return values.id
        ? kbService.updateCategory(values.id, payload)
        : kbService.createCategory({ ...payload, isActive: true });
    },
    onSuccess: async () => {
      await refresh();
      setDraft(emptyDraft);
      setError(null);
      toast.success('Category saved');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save the category.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => kbService.removeCategory(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Category deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Unable to delete.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Knowledge base categories</DialogTitle>
        </DialogHeader>

        {categories.isPending ? (
          <LoadingState />
        ) : categories.data && categories.data.length > 0 ? (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {categories.data.map((category: KbCategory) => (
              <li key={category.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{category.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    /{category.slug} · {VISIBILITY_LABELS[category.visibility]} · {category._count.articles} article(s)
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${category.name}`}
                    onClick={() =>
                      setDraft({
                        id: category.id,
                        name: category.name,
                        description: category.description ?? '',
                        visibility: category.visibility,
                        position: category.position,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${category.name}`}
                    onClick={() =>
                      void confirm({
                        title: `Delete ${category.name}?`,
                        confirmLabel: 'Delete category',
                        onConfirm: () => remove.mutateAsync(category.id),
                      })
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No categories yet" description="Group articles so customers can browse them." />
        )}

        <form
          className="space-y-3 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.name.trim()) {
              setError('Give the category a name.');
              return;
            }
            save.mutate(draft);
          }}
        >
          <Field label="Name" htmlFor="kb-category-name" required>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Billing & invoices"
            />
          </Field>
          <Field label="Description" htmlFor="kb-category-description">
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who can see it" htmlFor="kb-category-visibility">
              <Select
                value={draft.visibility}
                onChange={(event) => setDraft({ ...draft, visibility: event.target.value })}
              >
                {CONTENT_VISIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {VISIBILITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Position" htmlFor="kb-category-position">
              <Input
                type="number"
                min={0}
                value={draft.position}
                onChange={(event) => setDraft({ ...draft, position: Number(event.target.value) })}
              />
            </Field>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            {draft.id ? (
              <Button type="button" variant="outline" onClick={() => setDraft(emptyDraft)}>
                Cancel edit
              </Button>
            ) : null}
            <Button type="submit" loading={save.isPending}>
              <Plus className="h-4 w-4" aria-hidden />
              {draft.id ? 'Save category' : 'Add category'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
