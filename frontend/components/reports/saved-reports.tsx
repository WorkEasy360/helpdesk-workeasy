'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { PERMISSIONS, type ReportKind } from '@digisoft/shared';
import { analyticsService } from '@/services/analytics.service';
import { useAuthStore } from '@/stores/auth.store';
import type { ReportFilterValue } from './report-filters';
import { toQuery } from './report-filters';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Input, Select } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';

/**
 * Named, saved filter sets for the current report kind — so a team looks at the same
 * numbers every week without rebuilding the filter bar each time.
 */
export function SavedReports({
  kind,
  filters,
  onLoad,
}: {
  kind: ReportKind;
  filters: ReportFilterValue;
  onLoad: (filters: ReportFilterValue) => void;
}) {
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const definitions = useQuery({
    queryKey: ['report-definitions'],
    queryFn: analyticsService.listDefinitions,
  });
  const forKind = (definitions.data ?? []).filter((row) => row.kind === kind);

  const save = useMutation({
    mutationFn: () =>
      analyticsService.createDefinition({
        name: name.trim(),
        kind,
        filters: toQuery(filters),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['report-definitions'] });
      setNaming(false);
      setName('');
      setSelectedId(created.id);
      toast.success('Saved');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to save this view.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => analyticsService.removeDefinition(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['report-definitions'] });
      setSelectedId('');
      toast.success('Deleted');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to delete this view.'),
  });

  const load = (id: string) => {
    setSelectedId(id);
    const definition = forKind.find((row) => row.id === id);
    if (!definition) return;
    const saved = definition.filters as Partial<ReportFilterValue>;
    onLoad({
      range: saved.range ?? '30d',
      from: saved.from,
      to: saved.to,
      departmentId: saved.departmentId,
      agentId: saved.agentId,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-base">
      {forKind.length > 0 ? (
        <Select className="w-48" value={selectedId} onChange={(event) => load(event.target.value)}>
          <option value="">Saved views…</option>
          {forKind.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </Select>
      ) : null}

      {selectedId && can(PERMISSIONS.REPORT_MANAGE) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            void confirm({
              title: 'Delete this saved view?',
              confirmLabel: 'Delete',
              onConfirm: () => remove.mutateAsync(selectedId),
            })
          }
          loading={remove.isPending}
          aria-label="Delete this saved view"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}

      {can(PERMISSIONS.REPORT_MANAGE) ? (
        naming ? (
          <>
            <Input
              autoFocus
              className="w-40"
              placeholder="View name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && name.trim() && save.mutate()}
            />
            <Button
              type="button"
              size="sm"
              disabled={name.trim().length === 0}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setNaming(true)}>
            Save this view
          </Button>
        )
      ) : null}
    </div>
  );
}
