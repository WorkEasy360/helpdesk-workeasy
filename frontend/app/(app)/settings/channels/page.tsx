'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { channelsService } from '@/services/channels.service';
import { useAuthStore } from '@/stores/auth.store';
import { formatDateTime } from '@/lib/utils';
import type { Channel } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { ChannelDialog, CHANNEL_LABELS } from '@/components/channels/channel-dialog';

export default function ChannelsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.CHANNEL_MANAGE);

  const [dialog, setDialog] = useState<{ open: boolean; channel: Channel | null }>({
    open: false,
    channel: null,
  });
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [testTarget, setTestTarget] = useState<{ id: string; to: string } | null>(null);

  const channels = useQuery({ queryKey: ['channels'], queryFn: () => channelsService.list() });
  const events = useQuery({
    queryKey: ['channel-events'],
    queryFn: () => channelsService.events({ page: 1, pageSize: 10 }),
  });

  const rotate = useMutation({
    mutationFn: (id: string) => channelsService.rotateWebhook(id),
    onSuccess: (result) => {
      setWebhookUrl(result.webhookUrl);
      toast.success('New webhook URL generated — the old one has stopped working');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to rotate.'),
  });

  const test = useMutation({
    mutationFn: (input: { id: string; to: string }) => channelsService.test(input.id, { to: input.to }),
    onSuccess: () => {
      setTestTarget(null);
      toast.success('Test message sent');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The test failed.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => channelsService.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel deleted');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  return (
    <>
      <div className="flex justify-end">
        {manage ? (
          <Button onClick={() => setDialog({ open: true, channel: null })}>
            <Plus className="h-4 w-4" aria-hidden />
            New channel
          </Button>
        ) : null}
      </div>

      {webhookUrl ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-md">Webhook URL</CardTitle>
            <CardDescription>
              Give this to the provider. It contains the channel secret and is shown only now.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 text-xs">{webhookUrl}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(webhookUrl);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setWebhookUrl(null)}>
              Done
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        {channels.isPending ? (
          <TableSkeleton columns={5} />
        ) : channels.isError ? (
          <ErrorState
            message={channels.error instanceof ApiError ? channels.error.message : 'Unable to load channels.'}
            onRetry={() => channels.refetch()}
          />
        ) : channels.data.length === 0 ? (
          <EmptyState
            title="No channels yet"
            description="Connect a mailbox, live chat, a messaging app or a phone number so requests arrive where your customers already are."
            action={
              manage ? (
                <Button onClick={() => setDialog({ open: true, channel: null })}>New channel</Button>
              ) : null
            }
          />
        ) : (
          <DataTable>
            <THead>
              <TR>
                <TH>Channel</TH>
                <TH>Provider</TH>
                <TH>Routing</TH>
                <TH>Last activity</TH>
                <TH>State</TH>
                <TH>
                  <span className="sr-only">Manage</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {channels.data.map((channel) => (
                <TR key={channel.id}>
                  <TD>
                    <p className="font-medium">{channel.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {CHANNEL_LABELS[channel.type]}
                      {channel.identifier ? ` · ${channel.identifier}` : ''}
                    </p>
                  </TD>
                  <TD className="text-base text-muted-foreground">
                    {channel.provider}
                    {channel.configuredSecrets.length > 0 ? (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs">
                        <KeyRound className="h-3 w-3" aria-hidden />
                        {channel.configuredSecrets.length}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="text-base text-muted-foreground">
                    {channel.department?.name ?? 'Assignment rules'}
                    {channel.priority ? ` · ${channel.priority.name}` : ''}
                  </TD>
                  <TD className="text-xs text-muted-foreground">
                    {channel.lastInboundAt ? `In ${formatDateTime(channel.lastInboundAt)}` : 'No inbound yet'}
                    <br />
                    {channel.lastOutboundAt ? `Out ${formatDateTime(channel.lastOutboundAt)}` : '—'}
                  </TD>
                  <TD>
                    {channel.lastError ? (
                      <Badge variant="danger" title={channel.lastError}>
                        Error
                      </Badge>
                    ) : channel.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge>Off</Badge>
                    )}
                  </TD>
                  <TD className="text-right">
                    {manage ? (
                      <div className="flex justify-end gap-1">
                        {channel.canSend ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Send a test through ${channel.name}`}
                            onClick={() => setTestTarget({ id: channel.id, to: '' })}
                          >
                            <Send className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                        {channel.type !== 'CHAT' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Rotate the webhook URL for ${channel.name}`}
                            onClick={() => rotate.mutate(channel.id)}
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${channel.name}`}
                          onClick={() => setDialog({ open: true, channel })}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${channel.name}`}
                          onClick={() =>
                            void confirm({
                              title: `Delete ${channel.name}?`,
                              description: 'Messages will no longer be received on this channel.',
                              confirmLabel: 'Delete channel',
                              onConfirm: () => remove.mutateAsync(channel.id),
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

      {testTarget ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-md">Send a test message</CardTitle>
            <CardDescription>
              A real message goes out over the channel, so you can see it arrive.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Input
              className="w-full sm:w-80"
              placeholder="Address, number or chat id"
              value={testTarget.to}
              aria-label="Test recipient"
              onChange={(event) => setTestTarget({ ...testTarget, to: event.target.value })}
            />
            <Button loading={test.isPending} onClick={() => test.mutate(testTarget)}>
              Send test
            </Button>
            <Button variant="ghost" onClick={() => setTestTarget(null)}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-md">Recent deliveries</CardTitle>
          <CardDescription>Everything providers have posted, and what became of it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {events.data && events.data.items.length > 0 ? (
            <DataTable>
              <THead>
                <TR>
                  <TH>Channel</TH>
                  <TH>Reference</TH>
                  <TH>Outcome</TH>
                  <TH>Received</TH>
                </TR>
              </THead>
              <TBody>
                {events.data.items.map((event) => (
                  <TR key={event.id}>
                    <TD className="text-base">{event.channel.name}</TD>
                    <TD className="max-w-[18rem] truncate text-xs text-muted-foreground">
                      {event.externalId}
                    </TD>
                    <TD>
                      <Badge
                        variant={
                          event.status === 'PROCESSED'
                            ? 'success'
                            : event.status === 'FAILED'
                              ? 'danger'
                              : 'default'
                        }
                        title={event.error ?? undefined}
                      >
                        {event.status.toLowerCase()}
                      </Badge>
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatDateTime(event.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
          ) : (
            <p className="px-4 py-6 text-base text-muted-foreground">Nothing has arrived yet.</p>
          )}
        </CardContent>
      </Card>

      <ChannelDialog
        channel={dialog.channel}
        open={dialog.open}
        onOpenChange={(open) => setDialog({ open, channel: open ? dialog.channel : null })}
        onCreated={(url) => url && setWebhookUrl(url)}
      />
    </>
  );
}
