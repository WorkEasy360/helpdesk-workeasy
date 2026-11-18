'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Save } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, type HelpCenterSettingsInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { helpCenterService } from '@/services/help-center.service';
import { useAuthStore } from '@/stores/auth.store';
import type { HelpCenter } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input, Textarea } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';

interface Draft {
  slug: string;
  name: string;
  tagline: string;
  welcomeMessage: string;
  logoUrl: string;
  primaryColor: string;
  supportEmail: string;
  footerText: string;
  isPublished: boolean;
  allowPublicBrowsing: boolean;
  allowSelfRegistration: boolean;
  allowTicketSubmission: boolean;
  kbEnabled: boolean;
  communityEnabled: boolean;
  moderateCommunity: boolean;
}

function toDraft(helpCenter: HelpCenter): Draft {
  return {
    slug: helpCenter.slug,
    name: helpCenter.name,
    tagline: helpCenter.tagline ?? '',
    welcomeMessage: helpCenter.welcomeMessage ?? '',
    logoUrl: helpCenter.logoUrl ?? '',
    primaryColor: helpCenter.primaryColor,
    supportEmail: helpCenter.supportEmail ?? '',
    footerText: helpCenter.footerText ?? '',
    isPublished: helpCenter.isPublished,
    allowPublicBrowsing: helpCenter.allowPublicBrowsing,
    allowSelfRegistration: helpCenter.allowSelfRegistration,
    allowTicketSubmission: helpCenter.allowTicketSubmission,
    kbEnabled: helpCenter.kbEnabled,
    communityEnabled: helpCenter.communityEnabled,
    moderateCommunity: helpCenter.moderateCommunity,
  };
}

const TOGGLES: { key: keyof Draft; label: string; description: string }[] = [
  { key: 'isPublished', label: 'Help center is live', description: 'Turn off to take the whole site down.' },
  {
    key: 'allowPublicBrowsing',
    label: 'Anyone can browse',
    description: 'Off means visitors must sign in before they see anything.',
  },
  { key: 'allowSelfRegistration', label: 'Customers can create accounts', description: 'Off means accounts come from agents only.' },
  { key: 'allowTicketSubmission', label: 'Customers can raise requests', description: 'Controls forms and the portal request button.' },
  { key: 'kbEnabled', label: 'Knowledge base', description: 'Show published articles in the help center.' },
  { key: 'communityEnabled', label: 'Community', description: 'Let customers post and answer questions.' },
  {
    key: 'moderateCommunity',
    label: 'Moderate community posts',
    description: 'New customer posts wait for an agent before they appear.',
  },
];

export default function HelpCenterSettingsPage() {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const manage = can(PERMISSIONS.PORTAL_MANAGE);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const helpCenter = useQuery({ queryKey: ['help-center'], queryFn: helpCenterService.get });
  if (helpCenter.data && draft === null) {
    setDraft(toDraft(helpCenter.data));
  }

  const save = useMutation({
    mutationFn: (values: Draft) => {
      const payload: HelpCenterSettingsInput = {
        slug: values.slug,
        name: values.name,
        tagline: values.tagline || null,
        welcomeMessage: values.welcomeMessage || null,
        logoUrl: values.logoUrl || null,
        primaryColor: values.primaryColor,
        supportEmail: values.supportEmail || null,
        footerText: values.footerText || null,
        isPublished: values.isPublished,
        allowPublicBrowsing: values.allowPublicBrowsing,
        allowSelfRegistration: values.allowSelfRegistration,
        allowTicketSubmission: values.allowTicketSubmission,
        kbEnabled: values.kbEnabled,
        communityEnabled: values.communityEnabled,
        moderateCommunity: values.moderateCommunity,
      };
      return helpCenterService.update(payload);
    },
    onSuccess: async (saved) => {
      setError(null);
      setDraft(toDraft(saved));
      await queryClient.invalidateQueries({ queryKey: ['help-center'] });
      toast.success('Help center updated');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save the settings.'),
  });

  if (helpCenter.isPending || !draft) {
    return <LoadingState label="Loading help center…" />;
  }
  if (helpCenter.isError) {
    return (
      <ErrorState
        message={helpCenter.error instanceof ApiError ? helpCenter.error.message : 'Unable to load the help center.'}
        onRetry={() => helpCenter.refetch()}
      />
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Branding</CardTitle>
            <CardDescription>What customers see at /help/{draft.slug}.</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={`/help/${draft.slug}`} target="_blank">
              <ExternalLink className="h-4 w-4" aria-hidden />
              Open
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" htmlFor="hc-slug" hint="Used in the help center URL." required>
            <Input
              value={draft.slug}
              disabled={!manage}
              onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
            />
          </Field>
          <Field label="Name" htmlFor="hc-name" required>
            <Input
              value={draft.name}
              disabled={!manage}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="Tagline" htmlFor="hc-tagline">
            <Input
              value={draft.tagline}
              disabled={!manage}
              onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
            />
          </Field>
          <Field label="Support email" htmlFor="hc-email">
            <Input
              type="email"
              value={draft.supportEmail}
              disabled={!manage}
              onChange={(event) => setDraft({ ...draft, supportEmail: event.target.value })}
            />
          </Field>
          <Field label="Logo URL" htmlFor="hc-logo">
            <Input
              value={draft.logoUrl}
              disabled={!manage}
              placeholder="https://…"
              onChange={(event) => setDraft({ ...draft, logoUrl: event.target.value })}
            />
          </Field>
          <Field label="Accent colour" htmlFor="hc-color" hint="Hex, for example #2563eb.">
            <Input
              value={draft.primaryColor}
              disabled={!manage}
              onChange={(event) => setDraft({ ...draft, primaryColor: event.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Welcome message" htmlFor="hc-welcome">
              <Textarea
                rows={2}
                value={draft.welcomeMessage}
                disabled={!manage}
                onChange={(event) => setDraft({ ...draft, welcomeMessage: event.target.value })}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Footer text" htmlFor="hc-footer">
              <Input
                value={draft.footerText}
                disabled={!manage}
                onChange={(event) => setDraft({ ...draft, footerText: event.target.value })}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What the help center offers</CardTitle>
          <CardDescription>Each switch takes effect immediately for every visitor.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {TOGGLES.map((toggle) => (
            <label key={toggle.key} className="flex items-start gap-3 text-base">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                disabled={!manage}
                checked={Boolean(draft[toggle.key])}
                onChange={(event) => setDraft({ ...draft, [toggle.key]: event.target.checked })}
              />
              <span>
                <span className="font-medium">{toggle.label}</span>
                <span className="block text-xs text-muted-foreground">{toggle.description}</span>
              </span>
            </label>
          ))}
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
          {error}
        </p>
      ) : null}

      {manage ? (
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            <Save className="h-4 w-4" aria-hidden />
            Save changes
          </Button>
        </div>
      ) : null}
    </form>
  );
}
