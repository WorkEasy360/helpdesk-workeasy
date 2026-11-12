'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  csatSettingsSchema,
  type CsatSettingsFormValues,
  type CsatSettingsInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { analyticsService } from '@/services/analytics.service';
import { useAuthStore } from '@/stores/auth.store';
import type { CsatSettingsDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';

function toForm(settings: CsatSettingsDto): CsatSettingsFormValues {
  return {
    isEnabled: settings.isEnabled,
    delayMinutes: settings.delayMinutes,
    expiryDays: settings.expiryDays,
    subject: settings.subject,
    introText: settings.introText,
    thankYouText: settings.thankYouText,
  };
}

export default function CsatSettingsPage() {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const editable = can(PERMISSIONS.REPORT_MANAGE);

  const settings = useQuery({ queryKey: ['csat', 'settings'], queryFn: analyticsService.csatSettings });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CsatSettingsFormValues, unknown, CsatSettingsInput>({
    resolver: zodResolver(csatSettingsSchema),
  });

  useEffect(() => {
    if (settings.data) reset(toForm(settings.data));
  }, [settings.data, reset]);

  const save = useMutation({
    mutationFn: (values: CsatSettingsInput) => analyticsService.updateCsatSettings(values),
    onSuccess: (data) => {
      reset(toForm(data));
      queryClient.setQueryData(['csat', 'settings'], data);
      toast.success('Satisfaction survey settings saved');
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to save the settings.',
      }),
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) {
    return <ErrorState message="Unable to load the survey settings." onRetry={() => settings.refetch()} />;
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Satisfaction surveys</CardTitle>
        <CardDescription>
          When a ticket is resolved, the customer can be asked to rate the support they received.
          Each ticket is surveyed once, whatever happens to it afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((values) => save.mutateAsync(values))} className="space-y-4" noValidate>
          <label className="flex items-center gap-2 text-base font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              disabled={!editable}
              {...register('isEnabled')}
            />
            Send a satisfaction survey when a ticket is resolved
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Delay before sending"
              htmlFor="delayMinutes"
              error={errors.delayMinutes?.message}
              hint="Minutes after resolution. 0 sends immediately."
            >
              <Input id="delayMinutes" type="number" min={0} disabled={!editable} {...register('delayMinutes')} />
            </Field>
            <Field
              label="Link expires after"
              htmlFor="expiryDays"
              error={errors.expiryDays?.message}
              hint="Days the survey stays answerable."
            >
              <Input id="expiryDays" type="number" min={1} disabled={!editable} {...register('expiryDays')} />
            </Field>
          </div>

          <Field label="Email subject" htmlFor="subject" error={errors.subject?.message}>
            <Input id="subject" disabled={!editable} {...register('subject')} />
          </Field>

          <Field label="Intro text" htmlFor="introText" error={errors.introText?.message}>
            <Textarea id="introText" rows={3} disabled={!editable} {...register('introText')} />
          </Field>

          <Field label="Thank-you text" htmlFor="thankYouText" error={errors.thankYouText?.message}>
            <Textarea id="thankYouText" rows={2} disabled={!editable} {...register('thankYouText')} />
          </Field>

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
  );
}
