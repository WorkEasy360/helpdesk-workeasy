'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import '@/lib/zod-config';
import { z } from 'zod';
import { passwordSchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { authService } from '@/services/auth.service';
import { useAuthMethods } from '@/hooks/use-auth-methods';
import { useHydrated } from '@/hooks/use-hydrated';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const formSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

type FormValues = z.infer<typeof formSchema>;

export function ResetPasswordForm() {
  const { methods, isLoading } = useAuthMethods();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const isInvite = params.get('invite') === '1';
  const [done, setDone] = useState(false);

  const hydrated = useHydrated();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await authService.resetPassword({ token, password: values.password });
      setDone(true);
      setTimeout(() => router.replace('/login'), 1500);
    } catch (error) {
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to set the password.',
      });
    }
  });

  if (!isLoading && !methods.password) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password sign-in is turned off</CardTitle>
          <CardDescription>
            Agents sign in with Workeasy360, so there is no password to set here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Link is incomplete</CardTitle>
          <CardDescription>
            This page needs the token from your email. Request a new link and try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isInvite ? 'Set your password' : 'Choose a new password'}</CardTitle>
        <CardDescription>
          {isInvite
            ? 'Set a password to activate your agent account.'
            : 'Your other sessions will be signed out.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <p className="rounded-md bg-muted px-3 py-4 text-sm">
            Password updated. Taking you to sign in…
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="New password" htmlFor="password" error={errors.password?.message} required>
              <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
            </Field>
            <Field
              label="Confirm password"
              htmlFor="confirmPassword"
              error={errors.confirmPassword?.message}
              required
            >
              <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
            </Field>
            {errors.root ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errors.root.message}
              </p>
            ) : null}
            <Button type="submit" className="w-full" loading={isSubmitting} disabled={!hydrated}>
              Save password
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
