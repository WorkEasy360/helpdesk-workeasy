'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Play, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, WEBHOOK_EVENTS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { webhooksService } from '@/services/integrations.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.WEBHOOK_MANAGE);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', url: '', events: [] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const endpoints = useQuery({ queryKey: ['webhook-endpoints'], queryFn: webhooksService.list });
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', page],
    queryFn: () => webhooksService.deliveries({ page, pageSize: 15 }),
    refetchInterval: 15_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    await queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
  };

  const create = useMutation({
    mutationFn: () =>
      webhooksService.create({
        name: draft.name,
        url: draft.url,
        events: draft.events as never,
        isActive: true,
      }),
    onSuccess: async (endpoint) => {
      setSecret(endpoint.secret ?? null);
      setCreating(false);
      setDraft({ name: '', url: '', events: [] });
      setError(null);
      await refresh();
      toast.success('Endpoint created');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create the endpoint.'),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => webhooksService.rotateSecret(id),
    onSuccess: (result) => {
      setSecret(result.secret);
      toast.success('Signing secret rotated');
    },
  });

  const test = useMutation({
    mutationFn: (id: string) => webhooksService.test(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Test delivery queued');
    },
  });

  const replay = useMutation({
    mutationFn: (id: string) => webhooksService.replay(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Delivery queued again');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => webhooksService.remove(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Endpoint deleted');
    },
  });

  return (
    <>
      <div className="flex justify-end">
        {manage ? (
          <Button onClick={() => setCreating(!creating)}>
            <Plus className="h-4 w-4" aria-hidden />
            New endpoint
          </Button>
        ) : null}
      </div>

      {secret ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-base">Signing secret</CardTitle>
            <CardDescription>
              Verify it against <code>X-Digisoft-Signature</code>: HMAC-SHA256 over
              <code> timestamp.body</code>. Shown only now.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{secret}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(secret);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSecret(null)}>
              Done
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New endpoint</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="endpoint-name" required>
                  <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </Field>
                <Field label="URL" htmlFor="endpoint-url" required>
                  <Input
                    value={draft.url}
                    placeholder="https://example.com/hooks/digisoft"
                    onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  />
                </Field>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Events</legend>
                <p className="mb-2 text-xs text-muted-foreground">
                  Choose nothing to receive every event.
                </p>
                <div className="flex flex-wrap gap-3">
                  {WEBHOOK_EVENTS.map((event) => (
                    <label key={event} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={draft.events.includes(event)}
                        onChange={(changed) =>
                          setDraft({
                            ...draft,
                            events: changed.target.checked
                              ? [...draft.events, event]
                              : draft.events.filter((value) => value !== event),
                          })
                        }
                      />
                      <code className="text-xs">{event}</code>
                    </label>
                  ))}
                </div>
              </fieldset>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending}>
                  Create endpoint
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        {endpoints.isPending ? (
          <TableSkeleton columns={4} />
        ) : endpoints.isError ? (
          <ErrorState
            message={endpoints.error instanceof ApiError ? endpoints.error.message : 'Unable to load endpoints.'}
            onRetry={() => endpoints.refetch()}
          />
        ) : endpoints.data.length === 0 ? (
          <EmptyState
            title="No endpoints yet"
            description="Send ticket events to your own systems — every delivery is signed and retried."
          />
        ) : (
          <DataTable>
            <THead>
              <TR>
                <TH>Endpoint</TH>
                <TH>Events</TH>
                <TH>Health</TH>
                <TH className="text-right">Deliveries</TH>
                <TH>
                  <span className="sr-only">Manage</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {endpoints.data.map((endpoint) => (
                <TR key={endpoint.id}>
                  <TD>
                    <p className="font-medium">{endpoint.name}</p>
                    <p className="max-w-[24rem] truncate text-xs text-muted-foreground">{endpoint.url}</p>
                  </TD>
                  <TD className="text-xs text-muted-foreground">
                    {endpoint.events.length === 0 ? 'All events' : endpoint.events.join(', ')}
                  </TD>
                  <TD>
                    {endpoint.failureCount > 0 ? (
                      <Badge variant="danger">{endpoint.failureCount} failing</Badge>
                    ) : endpoint.lastSuccessAt ? (
                      <Badge variant="success">Healthy</Badge>
                    ) : (
                      <Badge>Untested</Badge>
                    )}
                  </TD>
                  <TD className="text-right text-sm">{endpoint._count.deliveries}</TD>
                  <TD className="text-right">
                    {manage ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Send a test to ${endpoint.name}`}
                          onClick={() => test.mutate(endpoint.id)}
                        >
                          <Play className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Rotate the secret for ${endpoint.name}`}
                          onClick={() => rotate.mutate(endpoint.id)}
                        >
                          <RefreshCw className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${endpoint.name}`}
                          onClick={() =>
                            void confirm({
                              title: `Delete ${endpoint.name}?`,
                              description: 'Events will stop being delivered to this endpoint.',
                              confirmLabel: 'Delete webhook',
                              onConfirm: () => remove.mutateAsync(endpoint.id),
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </DataTable>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deliveries</CardTitle>
          <CardDescription>Every attempt, with the response it got.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {deliveries.data && deliveries.data.items.length > 0 ? (
            <>
              <DataTable>
                <THead>
                  <TR>
                    <TH>Event</TH>
                    <TH>Endpoint</TH>
                    <TH>Result</TH>
                    <TH className="text-right">Attempts</TH>
                    <TH>When</TH>
                    <TH>
                      <span className="sr-only">Replay</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {deliveries.data.items.map((delivery) => (
                    <TR key={delivery.id}>
                      <TD className="text-sm">
                        <code className="text-xs">{delivery.event}</code>
                      </TD>
                      <TD className="text-sm text-muted-foreground">{delivery.endpoint.name}</TD>
                      <TD>
                        <Badge
                          variant={
                            delivery.status === 'DELIVERED'
                              ? 'success'
                              : delivery.status === 'FAILED'
                                ? 'danger'
                                : 'warning'
                          }
                          title={delivery.error ?? undefined}
                        >
                          {delivery.status.toLowerCase()}
                          {delivery.responseStatus ? ` · ${delivery.responseStatus}` : ''}
                        </Badge>
                      </TD>
                      <TD className="text-right text-sm">{delivery.attempts}</TD>
                      <TD className="text-xs text-muted-foreground">{formatDateTime(delivery.createdAt)}</TD>
                      <TD className="text-right">
                        {manage && delivery.status !== 'DELIVERED' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Replay this delivery"
                            onClick={() => replay.mutate(delivery.id)}
                          >
                            <RotateCcw className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </DataTable>
              <Pagination meta={deliveries.data.meta} onPageChange={setPage} />
            </>
          ) : (
            <p className="px-4 py-6 text-sm text-muted-foreground">Nothing delivered yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
