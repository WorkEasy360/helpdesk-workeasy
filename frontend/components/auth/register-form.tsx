'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  registerSchema,
  slugify,
  type RegisterFormValues,
  type RegisterInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useRegistrationEnabled } from '@/hooks/use-registration-enabled';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const TIMEZONE =
  typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

export function RegisterForm() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);

  const hydrated = useHydrated();
  // Once the address is hand-edited, typing in the name field stops overwriting it —
  // the same rule the knowledge base article editor's slug field follows.
  const [slugTouched, setSlugTouched] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues, unknown, RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { timezone: TIMEZONE || 'UTC' },
  });

  const name = watch('organizationName');
  const slug = watch('organizationSlug');

  useEffect(() => {
    if (!slugTouched) {
      setValue('organizationSlug', slugify(name ?? ''), { shouldValidate: false });
    }
  }, [name, slugTouched, setValue]);

  // Known up front from the API's registration flag; a refused submit (an API that
  // predates the flag) lands in the same state.
  const registrationEnabled = useRegistrationEnabled();
  const [refused, setRefused] = useState(false);
  const disabled = refused || !registrationEnabled;

  const onSubmit = handleSubmit(async (values) => {
    try {
      const session = await authService.register(values);
      setSession(session.user, session.accessToken);
      router.replace('/dashboard');
    } catch (error) {
      // Self-service sign-up can be switched off per deployment; the API then refuses
      // the route outright (403, or 404 when it is not mounted at all).
      if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404 || error.code === 'REGISTRATION_DISABLED')
      ) {
        setRefused(true);
        return;
      }
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to create the organization.',
      });
    }
  });

  if (disabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Registration is disabled</CardTitle>
          <CardDescription>
            New organizations cannot be created from this page. Contact your administrator to be
            invited to an existing workspace.
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
        <CardTitle>Create an organization</CardTitle>
        <CardDescription>
          You will become its first super admin. Everything you create stays private to this
          organization.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field
            label="Organization name"
            htmlFor="organizationName"
            error={errors.organizationName?.message}
            required
          >
            <Input autoFocus {...register('organizationName')} />
          </Field>

          <Field
            label="Organization address"
            htmlFor="organizationSlug"
            error={errors.organizationSlug?.message}
            hint={`Your help center: /help/${slug || 'your-organization'} — used to sign in when your email is shared across organizations`}
            required
          >
            <Input
              {...register('organizationSlug', {
                onChange: () => setSlugTouched(true),
              })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="firstName" error={errors.firstName?.message} required>
              <Input autoComplete="given-name" {...register('firstName')} />
            </Field>
            <Field label="Last name" htmlFor="lastName" error={errors.lastName?.message} required>
              <Input autoComplete="family-name" {...register('lastName')} />
            </Field>
          </div>

          <Field label="Work email" htmlFor="email" error={errors.email?.message} required>
            <Input type="email" autoComplete="email" {...register('email')} />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            error={errors.password?.message}
            hint="At least 10 characters, with upper case, lower case and a digit."
            required
          >
            <Input type="password" autoComplete="new-password" {...register('password')} />
          </Field>

          <input type="hidden" {...register('timezone')} />

          {errors.root ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errors.root.message}
            </p>
          ) : null}

          <Button type="submit" className="w-full" loading={isSubmitting} disabled={!hydrated}>
            Create organization
          </Button>
        </form>

        <p className="mt-4 text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
