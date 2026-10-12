'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import '@/lib/zod-config';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PERMISSIONS, passwordSchema } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { authService } from '@/services/auth.service';
import { usersService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const profileSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().min(1, 'Last name is required').max(80),
  phone: z.string().trim().max(40),
});
type ProfileValues = z.infer<typeof profileSchema>;

const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  });
type PasswordValues = z.infer<typeof passwordFormSchema>;

function ProfileDetails() {
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const can = useAuthStore((state) => state.can);
  const queryClient = useQueryClient();
  // Everyone may edit their own name and phone (`PATCH /auth/me`). The current phone
  // number is only on the user record, which needs `user.read` to load.
  const canRead = can(PERMISSIONS.USER_READ);

  const record = useQuery({
    queryKey: ['users', user?.id],
    queryFn: () => usersService.get(user!.id),
    enabled: Boolean(user && canRead),
  });

  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { firstName: user?.firstName ?? '', lastName: user?.lastName ?? '', phone: '' },
  });

  useEffect(() => {
    if (record.data) {
      form.reset({
        firstName: record.data.firstName,
        lastName: record.data.lastName,
        phone: record.data.phone ?? '',
      });
    }
  }, [record.data, form]);

  const save = useMutation({
    mutationFn: (values: ProfileValues) =>
      authService.updateMe({
        firstName: values.firstName,
        lastName: values.lastName,
        // Without the current number on screen an untouched field must not clear it.
        ...(form.formState.dirtyFields.phone ? { phone: values.phone || null } : {}),
      }),
    onSuccess: async (identity, values) => {
      setUser(identity);
      form.reset({ firstName: identity.firstName, lastName: identity.lastName, phone: values.phone });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Profile updated');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update your profile.'),
  });

  if (!user) return null;
  const errors = form.formState.errors;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your profile</CardTitle>
        <CardDescription>
          How you appear to teammates and customers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-xl gap-4 sm:grid-cols-2"
          onSubmit={form.handleSubmit((values) => save.mutate(values))}
          noValidate
        >
          <Field label="First name" htmlFor="profile-first-name" error={errors.firstName?.message} required>
            <Input autoComplete="given-name" {...form.register('firstName')} />
          </Field>
          <Field label="Last name" htmlFor="profile-last-name" error={errors.lastName?.message} required>
            <Input autoComplete="family-name" {...form.register('lastName')} />
          </Field>
          <Field label="Email" htmlFor="profile-email" hint="Contact an administrator to change your sign-in email.">
            <Input type="email" value={user.email} readOnly disabled />
          </Field>
          <Field
            label="Phone"
            htmlFor="profile-phone"
            error={errors.phone?.message}
            hint={canRead ? undefined : 'Leave blank to keep the number on file.'}
          >
            <Input type="tel" autoComplete="tel" {...form.register('phone')} />
          </Field>
          <div className="space-y-1.5 sm:col-span-2">
            <p className="text-sm font-medium">Roles</p>
            <div className="flex flex-wrap gap-1">
              {user.roles.length ? (
                user.roles.map((role) => <Badge key={role}>{role}</Badge>)
              ) : (
                <span className="text-sm text-muted-foreground">None</span>
              )}
            </div>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePassword() {
  const router = useRouter();
  const clear = useAuthStore((state) => state.clear);
  const queryClient = useQueryClient();

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const errors = form.formState.errors;

  const change = useMutation({
    mutationFn: (values: PasswordValues) =>
      authService.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
    onSuccess: () => {
      // The API revokes every session on a password change, this one included.
      toast.success('Password changed. Sign in again with your new password.');
      clear();
      queryClient.clear();
      router.replace('/login');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
        form.setError('currentPassword', { message: 'Current password is incorrect' });
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Unable to change your password.');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>You will be signed out on every device and asked to sign in again.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-md gap-4"
          onSubmit={form.handleSubmit((values) => change.mutate(values))}
          noValidate
        >
          <Field label="Current password" htmlFor="current-password" error={errors.currentPassword?.message} required>
            <Input type="password" autoComplete="current-password" {...form.register('currentPassword')} />
          </Field>
          <Field
            label="New password"
            htmlFor="new-password"
            error={errors.newPassword?.message}
            hint="At least 10 characters, with upper- and lowercase letters and a digit."
            required
          >
            <Input type="password" autoComplete="new-password" {...form.register('newPassword')} />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password" error={errors.confirmPassword?.message} required>
            <Input type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
          </Field>
          <div>
            <Button type="submit" loading={change.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ProfileSettingsPage() {
  return (
    <>
      <ProfileDetails />
      <ChangePassword />
    </>
  );
}
