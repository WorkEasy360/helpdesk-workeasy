'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight } from 'lucide-react';
import { loginSchema, type LoginInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { safeReturnPath } from '@/lib/utils';
import { ssoErrorMessage, workeasy360StartUrl } from '@/lib/sso';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/stores/auth.store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useAuthMethods } from '@/hooks/use-auth-methods';
import { useRegistrationEnabled } from '@/hooks/use-registration-enabled';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/states';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type OrganizationChoice = { slug: string; name: string };

/**
 * A one-screen sign-in: email and password only, no organization address up front. The
 * same address can be a distinct account in more than one organization — the server
 * checks the password against every one of them, and only asks which organization to
 * enter when more than one actually matched.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Where an expired session or a deep link was heading before sign-in interrupted it.
  const requestedNext = searchParams.get('next');
  const destination = safeReturnPath(requestedNext, '/dashboard');
  // Why a Workeasy360 sign-in did not complete (a fixed set of codes; anything else reads as "refused").
  const ssoError = ssoErrorMessage(searchParams.get('sso_error'));
  // A password-era session was refused because sign-in is Workeasy360-only now.
  const signInRequired = searchParams.get('signin') === 'workeasy360';
  const { methods, isLoading: methodsLoading } = useAuthMethods();
  const setSession = useAuthStore((state) => state.setSession);
  const status = useAuthStore((state) => state.status);
  const hydrated = useHydrated();
  const registrationEnabled = useRegistrationEnabled();

  const [organizations, setOrganizations] = useState<OrganizationChoice[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(destination);
    }
  }, [status, router, destination]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await authService.login(values);
      if (result.status === 'choose_organization') {
        setOrganizations(result.organizations);
        return;
      }
      setSession(result.user, result.accessToken);
      router.replace(destination);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Unable to sign in. Please try again.';
      setError('root', { message });
    }
  });

  const chooseOrganization = async (slug: string) => {
    setChoosing(true);
    setChooseError(null);
    try {
      const { email, password } = getValues();
      const result = await authService.login({ email, password, organizationSlug: slug });
      if (result.status === 'choose_organization') {
        // Can only happen if the password changed between the two requests.
        throw new ApiError('INVALID_CREDENTIALS', 'Incorrect email address or password', 401);
      }
      setSession(result.user, result.accessToken);
      router.replace(destination);
    } catch (error) {
      setChooseError(
        error instanceof ApiError ? error.message : 'Unable to sign in. Please try again.',
      );
    } finally {
      setChoosing(false);
    }
  };

  if (organizations) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Choose an organization</CardTitle>
          <CardDescription>
            Your email address is used to sign in to more than one organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {organizations.map((org) => (
              <li key={org.slug}>
                <button
                  type="button"
                  disabled={choosing}
                  onClick={() => chooseOrganization(org.slug)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  <span>
                    <span className="block font-medium">{org.name}</span>
                    <span className="block text-xs text-muted-foreground">{org.slug}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>

          {chooseError ? (
            <p
              role="alert"
              className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              {chooseError}
            </p>
          ) : null}

          <Button
            type="button"
            variant="outline"
            className="mt-4 w-full"
            onClick={() => {
              setOrganizations(null);
              setChooseError(null);
            }}
          >
            Back
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Never auto-started: Workeasy360 sign-in is a choice the person makes, by clicking.
  const workeasy360 = methods.workeasy360 ? (
    <div className={methods.password ? 'mt-5 border-t border-border pt-5' : undefined}>
      <p className="mb-3 text-sm text-muted-foreground">Already a Workeasy360 user?</p>
      <Button asChild variant={methods.password ? 'outline' : 'default'} className="w-full">
        <a href={workeasy360StartUrl({ next: destination === '/dashboard' ? null : destination })}>
          Continue with Workeasy360
        </a>
      </Button>
    </div>
  ) : null;

  const passwordForm = (
    <>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email address" htmlFor="email" error={errors.email?.message} required>
          <Input type="email" autoComplete="email" autoFocus {...register('email')} />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password?.message} required>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>

        {errors.root ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            {errors.root.message}
          </p>
        ) : null}

        <Button type="submit" className="w-full" loading={isSubmitting} disabled={!hydrated}>
          Sign in
        </Button>
      </form>

      <div className="mt-4 flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
          Forgot password?
        </Link>
        {registrationEnabled ? (
          <Link href="/register" className="text-muted-foreground hover:text-foreground">
            Create an organization
          </Link>
        ) : null}
      </div>
      {workeasy360}
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Sign in</CardTitle>
        <CardDescription>
          {methods.password
            ? 'Use your agent account to access the workspace.'
            : 'Agents sign in with their Workeasy360 account.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {signInRequired ? (
          <p role="status" className="mb-4 rounded-md bg-muted px-3 py-2 text-sm">
            Your Easy Help Desk account now signs in with Workeasy360. Continue with Workeasy360
            below: it links your account by your verified email address.
          </p>
        ) : null}
        {ssoError ? (
          <p
            role="alert"
            className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            {ssoError}
          </p>
        ) : null}

        {methodsLoading ? <LoadingState /> : null}

        {!methodsLoading && !methods.password && !methods.workeasy360 ? (
          <p role="alert" className="rounded-md bg-muted px-3 py-2 text-sm">
            Sign-in is not available on this deployment. Contact your administrator.
          </p>
        ) : null}

        {!methodsLoading && !methods.password ? workeasy360 : null}

        {!methodsLoading && methods.password ? passwordForm : null}
      </CardContent>
    </Card>
  );
}
