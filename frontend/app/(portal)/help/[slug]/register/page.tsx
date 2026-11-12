'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { usePortalSession } from '@/components/portal/portal-session';

export default function PortalRegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const router = useRouter();
  const session = usePortalSession();

  const [values, setValues] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const config = useQuery({ queryKey: ['portal-config', slug], queryFn: api.config });

  if (config.data && !config.data.allowSelfRegistration) {
    return (
      <div className="mx-auto w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Accounts are created by the support team</CardTitle>
            <CardDescription>
              Raise a request and the team will set you up, or sign in if you already have an account.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button asChild>
              <Link href={`/help/${slug}/submit`}>Submit a request</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/help/${slug}/login`}>Sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.register({
        firstName: values.firstName,
        lastName: values.lastName || null,
        email: values.email,
        password: values.password,
      });
      await session.signedIn(result.accessToken);
      router.replace(`/help/${slug}/tickets`);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const issues = err.details as { path: string; message: string }[];
        setError(issues.map((issue) => issue.message).join(' · '));
      } else {
        setError(err instanceof ApiError ? err.message : 'Unable to create the account.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
          <CardDescription>Keep every request and reply in one place.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="portal-first-name" required>
                <Input
                  value={values.firstName}
                  onChange={(event) => setValues({ ...values, firstName: event.target.value })}
                />
              </Field>
              <Field label="Last name" htmlFor="portal-last-name">
                <Input
                  value={values.lastName}
                  onChange={(event) => setValues({ ...values, lastName: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Email address" htmlFor="portal-register-email" required>
              <Input
                type="email"
                autoComplete="email"
                value={values.email}
                onChange={(event) => setValues({ ...values, email: event.target.value })}
              />
            </Field>
            <Field
              label="Password"
              htmlFor="portal-register-password"
              required
              hint="At least 10 characters, with an upper case letter and a digit."
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={values.password}
                onChange={(event) => setValues({ ...values, password: event.target.value })}
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" loading={busy}>
              Create account
            </Button>
          </form>
          <p className="mt-4 text-base text-muted-foreground">
            Already registered?{' '}
            <Link className="font-medium text-foreground hover:underline" href={`/help/${slug}/login`}>
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
