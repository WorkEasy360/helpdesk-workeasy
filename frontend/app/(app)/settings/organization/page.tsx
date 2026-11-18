'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  updateOrganizationSchema,
  type OrganizationFormValues,
  type UpdateOrganizationInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { organizationService } from '@/services/settings.service';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function OrganizationSettingsPage() {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const editable = can(PERMISSIONS.ORGANIZATION_UPDATE);

  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: organizationService.current,
  });
  const businessHours = useQuery({
    queryKey: ['organization', 'business-hours'],
    queryFn: organizationService.businessHours,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<OrganizationFormValues, unknown, UpdateOrganizationInput>({
    resolver: zodResolver(updateOrganizationSchema),
  });

  useEffect(() => {
    if (organization.data) {
      reset({
        name: organization.data.name,
        domain: organization.data.domain ?? '',
        timezone: organization.data.timezone,
        locale: organization.data.locale,
        currency: organization.data.currency,
      });
    }
  }, [organization.data, reset]);

  const save = useMutation({
    mutationFn: (values: UpdateOrganizationInput) =>
      organizationService.update(values),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['organization'] });
      reset({
        name: data.name,
        domain: data.domain ?? '',
        timezone: data.timezone,
        locale: data.locale,
        currency: data.currency,
      });
      toast.success('Organization updated');
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to save changes.',
      }),
  });

  if (organization.isPending) return <LoadingState />;
  if (organization.isError) {
    return <ErrorState message="Unable to load the organization." onRetry={() => organization.refetch()} />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Organization profile</CardTitle>
          <CardDescription>
            Address <code className="font-mono">{organization.data.slug}</code> — used when signing in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit((values) => save.mutateAsync(values))}
            className="space-y-4"
            noValidate
          >
            <Field label="Name" htmlFor="name" error={errors.name?.message}>
              <Input disabled={!editable} {...register('name')} />
            </Field>
            <Field
              label="Support domain"
              htmlFor="domain"
              error={errors.domain?.message}
              hint="Used to route inbound email to this organization."
            >
              <Input disabled={!editable} {...register('domain')} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Timezone" htmlFor="timezone" error={errors.timezone?.message}>
                <Input disabled={!editable} {...register('timezone')} />
              </Field>
              <Field label="Locale" htmlFor="locale" error={errors.locale?.message}>
                <Input disabled={!editable} {...register('locale')} />
              </Field>
              <Field label="Currency" htmlFor="currency" error={errors.currency?.message}>
                <Input disabled={!editable} {...register('currency')} />
              </Field>
            </div>

            {errors.root ? (
              <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
                {errors.root.message}
              </p>
            ) : null}

            {editable ? (
              <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
                Save changes
              </Button>
            ) : (
              <p className="text-base text-muted-foreground">
                You do not have permission to change these settings.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Business hours</CardTitle>
          <CardDescription>
            Working windows the SLA engine measures first-response and resolution targets against.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {businessHours.isPending ? (
            <LoadingState />
          ) : businessHours.isError ? (
            <ErrorState message="Unable to load business hours." onRetry={() => businessHours.refetch()} />
          ) : (
            businessHours.data.map((hours) => (
              <div key={hours.id} className="space-y-2">
                <p className="text-base font-medium">
                  {hours.name} <span className="text-muted-foreground">({hours.timezone})</span>
                </p>
                <ul className="space-y-1 text-base text-muted-foreground">
                  {hours.weeklySchedule.map((slot) => (
                    <li key={`${hours.id}-${slot.day}`} className="flex justify-between border-b border-border py-1">
                      <span>{DAY_NAMES[slot.day]}</span>
                      <span className="tabular-nums">
                        {slot.start} – {slot.end}
                      </span>
                    </li>
                  ))}
                </ul>
                {hours.holidays.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {hours.holidays.length} holiday{hours.holidays.length === 1 ? '' : 's'} configured
                  </p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
