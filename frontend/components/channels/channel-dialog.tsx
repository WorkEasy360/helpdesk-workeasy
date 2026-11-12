'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CHANNEL_TYPES, type ChannelInput, type ChannelType } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { channelsService } from '@/services/channels.service';
import { departmentsService } from '@/services/settings.service';
import { ticketConfigService } from '@/services/tickets.service';
import type { Channel } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  EMAIL: 'Email',
  CHAT: 'Live chat',
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Messenger',
  TELEGRAM: 'Telegram',
  VOICE: 'Telephony',
};

const IDENTIFIER_LABEL: Record<ChannelType, string> = {
  EMAIL: 'Support address',
  CHAT: 'Website (optional)',
  WHATSAPP: 'WhatsApp number',
  INSTAGRAM: 'Instagram account id',
  FACEBOOK: 'Page id',
  TELEGRAM: 'Bot username',
  VOICE: 'Phone number',
};

interface Draft {
  type: ChannelType;
  provider: string;
  name: string;
  identifier: string;
  departmentId: string;
  priorityId: string;
  categoryId: string;
  isActive: boolean;
  configJson: string;
  secrets: Record<string, string>;
}

const emptyDraft: Draft = {
  type: 'EMAIL',
  provider: 'generic',
  name: '',
  identifier: '',
  departmentId: '',
  priorityId: '',
  categoryId: '',
  isActive: true,
  configJson: '{\n  "stripQuotedText": true\n}',
  secrets: {},
};

function toDraft(channel: Channel): Draft {
  return {
    type: channel.type,
    provider: channel.provider,
    name: channel.name,
    identifier: channel.identifier ?? '',
    departmentId: channel.departmentId ?? '',
    priorityId: channel.priorityId ?? '',
    categoryId: channel.categoryId ?? '',
    isActive: channel.isActive,
    configJson: JSON.stringify(channel.config ?? {}, null, 2),
    secrets: {},
  };
}

/** Create and edit a channel. Credentials are write-only: stored values never come back. */
export function ChannelDialog({
  channel,
  open,
  onOpenChange,
  onCreated,
}: {
  channel: Channel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (webhookUrl: string | undefined) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(channel ? toDraft(channel) : emptyDraft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(channel ? toDraft(channel) : emptyDraft);
      setError(null);
    }
  }, [open, channel]);

  const catalogue = useQuery({
    queryKey: ['channel-catalogue'],
    queryFn: channelsService.catalogue,
    enabled: open,
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: departmentsService.list,
    enabled: open,
  });
  const priorities = useQuery({
    queryKey: ['ticket-priorities'],
    queryFn: ticketConfigService.priorities,
    enabled: open,
  });

  const providers = catalogue.data?.providers[draft.type] ?? [];
  const secretFields = catalogue.data?.secretFields[draft.provider] ?? [];

  const save = useMutation({
    mutationFn: (values: Draft) => {
      let config: Record<string, unknown> = {};
      try {
        config = values.configJson.trim() ? (JSON.parse(values.configJson) as Record<string, unknown>) : {};
      } catch {
        throw new Error('Settings must be valid JSON');
      }
      const secrets = Object.fromEntries(
        Object.entries(values.secrets).filter(([, value]) => value.trim().length > 0),
      );
      const payload: ChannelInput = {
        type: values.type,
        provider: values.provider,
        name: values.name,
        identifier: values.identifier || null,
        isActive: values.isActive,
        config,
        departmentId: values.departmentId || null,
        priorityId: values.priorityId || null,
        categoryId: values.categoryId || null,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      };
      return channel
        ? channelsService.update(channel.id, payload)
        : channelsService.create(payload);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel saved');
      onOpenChange(false);
      onCreated(saved.webhookUrl);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unable to save.'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{channel ? `Edit ${channel.name}` : 'New channel'}</DialogTitle>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.name.trim()) {
              setError('Give the channel a name.');
              return;
            }
            save.mutate(draft);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Channel" htmlFor="channel-type" required>
              <Select
                value={draft.type}
                disabled={channel !== null}
                onChange={(event) => {
                  const type = event.target.value as ChannelType;
                  const nextProviders = catalogue.data?.providers[type] ?? [];
                  setDraft({ ...draft, type, provider: nextProviders[0] ?? '', secrets: {} });
                }}
              >
                {CHANNEL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {CHANNEL_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Provider" htmlFor="channel-provider" required>
              <Select
                value={draft.provider}
                onChange={(event) => setDraft({ ...draft, provider: event.target.value, secrets: {} })}
              >
                {providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" htmlFor="channel-name" required>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label={IDENTIFIER_LABEL[draft.type]} htmlFor="channel-identifier">
              <Input
                value={draft.identifier}
                onChange={(event) => setDraft({ ...draft, identifier: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Route to department" htmlFor="channel-department">
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
            <Field label="Priority" htmlFor="channel-priority">
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

          {secretFields.length > 0 ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-base font-medium">Credentials</p>
              <p className="text-xs text-muted-foreground">
                Stored encrypted and never shown again. Leave a field blank to keep what is saved.
              </p>
              {secretFields.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  htmlFor={`secret-${field.key}`}
                  required={field.required && !channel}
                  hint={
                    channel?.configuredSecrets.includes(field.key) ? 'A value is already stored.' : undefined
                  }
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    value={draft.secrets[field.key] ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, secrets: { ...draft.secrets, [field.key]: event.target.value } })
                    }
                  />
                </Field>
              ))}
            </div>
          ) : null}

          <Field
            label="Settings"
            htmlFor="channel-config"
            hint="JSON. Email accepts fromName, replyTo, signature and stripQuotedText; chat accepts greeting, offlineMessage and requireEmail."
          >
            <Textarea
              rows={6}
              className="font-mono text-xs"
              value={draft.configJson}
              onChange={(event) => setDraft({ ...draft, configJson: event.target.value })}
            />
          </Field>

          <label className="flex items-center gap-2 text-base">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={draft.isActive}
              onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
            />
            Active
          </label>

          {error ? <p role="alert" className="text-base text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save channel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
