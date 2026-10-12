'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

/** Consumes the token from a customer's reset email (the help center's own endpoint). */
export default function PortalResetPasswordPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await portalService(slug).resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.replace(`/help/${slug}/login`), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to set the password.');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>This link is incomplete</CardTitle>
            <CardDescription>Request a new reset link and try again.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link href={`/help/${slug}/forgot-password`}>Request a new link</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>Your other sessions will be signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <p className="rounded-md bg-muted px-3 py-4 text-sm">Password updated. Taking you to sign in…</p>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit} noValidate>
              <Field label="New password" htmlFor="portal-new-password" required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <Field label="Confirm password" htmlFor="portal-confirm-password" required>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </Field>
              {error ? (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="w-full" loading={busy}>
                Save password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
