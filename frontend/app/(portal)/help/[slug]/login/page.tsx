'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { usePortalSession } from '@/components/portal/portal-session';

export default function PortalLoginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = usePortalSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = useQuery({ queryKey: ['portal-config', slug], queryFn: api.config });
  // A path inside this help center only, e.g. "tickets" or "tickets/abc123".
  const rawNext = searchParams.get('next');
  const next =
    rawNext && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(rawNext) ? rawNext : null;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.login({ email, password });
      await session.signedIn(result.accessToken);
      router.replace(next ? `/help/${slug}/${next}` : `/help/${slug}/tickets`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Follow your requests and join the community.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <Field label="Email address" htmlFor="portal-email" required>
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="portal-password" required>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>

          <div className="mt-4 space-y-1 text-sm text-muted-foreground">
            <p>
              <Link className="hover:underline" href={`/help/${slug}/forgot-password`}>
                Forgot your password?
              </Link>
            </p>
            {config.data?.allowSelfRegistration ? (
              <p>
                New here?{' '}
                <Link className="font-medium text-foreground hover:underline" href={`/help/${slug}/register`}>
                  Create an account
                </Link>
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
