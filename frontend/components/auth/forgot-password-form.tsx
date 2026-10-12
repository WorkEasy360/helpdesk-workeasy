'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@digisoft/shared';
import { authService } from '@/services/auth.service';
import { useAuthMethods } from '@/hooks/use-auth-methods';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ForgotPasswordForm() {
  const { methods, isLoading } = useAuthMethods();
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    // The API deliberately answers the same way for known and unknown addresses.
    await authService.forgotPassword(values).catch(() => undefined);
    setSent(true);
  });

  if (!isLoading && !methods.password) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password sign-in is turned off</CardTitle>
          <CardDescription>
            Agents sign in with Workeasy360, so there is no password to reset here.
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>We will email you a link to choose a new password.</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <p className="rounded-md bg-muted px-3 py-4 text-sm">
            If that address belongs to an account, a reset link is on its way. The link expires in
            60 minutes.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email address" htmlFor="email" error={errors.email?.message} required>
              <Input type="email" autoComplete="email" autoFocus {...register('email')} />
            </Field>
            <Field
              label="Organization address"
              htmlFor="organizationSlug"
              error={errors.organizationSlug?.message}
              hint="Optional, unless your email is used in more than one organization."
            >
              <Input {...register('organizationSlug')} />
            </Field>
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Send reset link
            </Button>
          </form>
        )}
        <p className="mt-4 text-sm">
          <Link href="/login" className="text-muted-foreground hover:text-foreground">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
