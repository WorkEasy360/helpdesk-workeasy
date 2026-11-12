'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

export default function PortalForgotPasswordPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await portalService(slug).forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to send the link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>We will email you a link to choose a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <p className="rounded-md bg-muted px-3 py-4 text-base">
              If that address has an account, the link is on its way. It expires in an hour.
            </p>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit} noValidate>
              <Field label="Email address" htmlFor="portal-forgot-email" required>
                <Input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              {error ? (
                <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="w-full" loading={busy}>
                Send the link
              </Button>
            </form>
          )}
          <p className="mt-4 text-base text-muted-foreground">
            <Link className="hover:underline" href={`/help/${slug}/login`}>
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
