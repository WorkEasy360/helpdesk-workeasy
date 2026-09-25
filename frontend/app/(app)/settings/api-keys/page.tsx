'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { apiKeysService } from '@/services/integrations.service';
import { rolesService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input, Select } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.APIKEY_MANAGE);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', roleId: '' });
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: apiKeysService.list });
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesService.list });

  const create = useMutation({
    mutationFn: () => apiKeysService.create({ name: draft.name, roleId: draft.roleId, expiresAt: null }),
    onSuccess: async (key) => {
      setIssued(key.key ?? null);
      setCreating(false);
      setDraft({ name: '', roleId: '' });
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API key created');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create the key.'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiKeysService.revoke(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('Key revoked');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Unable to revoke.'),
  });

  return (
    <>
      <div className="flex justify-end">
        {manage ? (
          <Button onClick={() => setCreating(!creating)}>
            <Plus className="h-4 w-4" aria-hidden />
            New API key
          </Button>
        ) : null}
      </div>

      {issued ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">Copy this key now</CardTitle>
            <CardDescription>
              Send it as <code>X-Api-Key</code>. It is stored hashed, so this is the only time it can be shown.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{issued}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(issued);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
              Done
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New API key</CardTitle>
            <CardDescription>
              A key carries a role, so an integration can do exactly what that role allows — no more.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.name.trim() || !draft.roleId) {
                  setError('Give the key a name and a role.');
                  return;
                }
                create.mutate();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="key-name" required>
                  <Input
                    value={draft.name}
                    placeholder="CRM integration"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Field>
                <Field label="Role" htmlFor="key-role" required>
                  <Select
                    value={draft.roleId}
                    onChange={(event) => setDraft({ ...draft, roleId: event.target.value })}
                  >
                    <option value="">Choose a role…</option>
                    {(roles.data ?? []).map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending}>
                  Create key
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        {keys.isPending ? (
          <TableSkeleton columns={4} />
        ) : keys.isError ? (
          <ErrorState
            message={keys.error instanceof ApiError ? keys.error.message : 'Unable to load API keys.'}
            onRetry={() => keys.refetch()}
          />
        ) : keys.data.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            description="Issue a key so another system can raise and read tickets through the API."
          />
        ) : (
          <DataTable>
            <THead>
              <TR>
                <TH>Key</TH>
                <TH>Role</TH>
                <TH>Last used</TH>
                <TH>State</TH>
                <TH>
                  <span className="sr-only">Revoke</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {keys.data.map((key) => (
                <TR key={key.id}>
                  <TD>
                    <p className="font-medium">{key.name}</p>
                    <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <KeyRound className="h-3 w-3" aria-hidden />
                      {key.prefix}…
                    </p>
                  </TD>
                  <TD className="text-sm text-muted-foreground">{key.role.name}</TD>
                  <TD className="text-xs text-muted-foreground">
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'Never'}
                  </TD>
                  <TD>
                    {key.revokedAt ? <Badge variant="danger">Revoked</Badge> : <Badge variant="success">Active</Badge>}
                  </TD>
                  <TD className="text-right">
                    {manage && !key.revokedAt ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke ${key.name}`}
                        onClick={() =>
                          void confirm({
                            title: `Revoke ${key.name}?`,
                            description: 'Integrations using this key stop working immediately. This cannot be undone.',
                            confirmLabel: 'Revoke key',
                            onConfirm: () => revoke.mutateAsync(key.id),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
