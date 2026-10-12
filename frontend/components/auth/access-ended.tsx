'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useHydrated } from '@/hooks/use-hydrated';
import { useSignOut } from '@/hooks/use-sign-out';
import type { AccessEndedReason } from '@/lib/sso';

const DETAILS: Record<string, string> = {
  expired: 'The trial or plan for this organization has ended.',
  suspended: 'The subscription for this organization is suspended.',
  not_entitled: 'This organization does not have Easy Help Desk.',
  membership_inactive:
    'Your account was disabled, or you were removed from this organization, in Workeasy360.',
  no_seat: 'Your Easy Help Desk seat was removed.',
  read_only: 'The subscription for this organization is read-only.',
};

const COPY: Record<AccessEndedReason, { title: string; description: string }> = {
  ended: {
    title: 'Your access to Easy Help Desk has ended',
    description: 'You are still signed in, but this workspace cannot be used right now.',
  },
  read_only: {
    title: 'Easy Help Desk is read-only',
    description:
      'You can look at tickets, reports and settings, but nothing can be changed until the subscription is active again.',
  },
  unverified: {
    title: 'Easy Help Desk cannot confirm your access',
    description:
      'Workeasy360 did not confirm that your organization still has Easy Help Desk. This is usually temporary.',
  },
};

function isReason(value: string | null): value is AccessEndedReason {
  return value === 'ended' || value === 'read_only' || value === 'unverified';
}

/**
 * The one screen a signed-in person sees when Easy Help Desk access ended for them (or cannot
 * be confirmed). Their session is still valid, so they can try again - which simply loads the
 * app, and the API asks Workeasy360 again - or sign out.
 */
export function AccessEnded() {
  const params = useSearchParams();
  const requested = params.get('reason');
  const reason: AccessEndedReason = isReason(requested) ? requested : 'ended';
  const detail = DETAILS[params.get('detail') ?? ''];
  const copy = COPY[reason];
  const { signOut, signOutOfWorkeasy360, canSignOutOfWorkeasy360, error } = useSignOut();
  const [busy, setBusy] = useState(false);
  // The buttons do nothing until the page is interactive; say so rather than swallow a click.
  const hydrated = useHydrated();

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {detail ? (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
            {detail}
          </p>
        ) : null}
        {reason !== 'unverified' ? (
          <p className="text-sm text-muted-foreground">
            An owner of your organization can sort this out in Workeasy360.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        ) : null}

        <Button
          className="w-full"
          disabled={busy || !hydrated}
          onClick={() => {
            // A full load: the app starts again and the API asks Workeasy360 again.
            window.location.assign('/dashboard');
          }}
        >
          Try again
        </Button>
        {reason === 'read_only' ? (
          <Button asChild variant="outline" className="w-full">
            <Link href="/dashboard">Continue in read-only mode</Link>
          </Button>
        ) : null}
        <Button
          variant="outline"
          className="w-full"
          disabled={busy || !hydrated}
          onClick={() => void run(signOut)}
        >
          Sign out
        </Button>
        {canSignOutOfWorkeasy360 ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !hydrated}
            onClick={() => void run(signOutOfWorkeasy360)}
          >
            Sign out of Easy Help Desk and Workeasy360
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
