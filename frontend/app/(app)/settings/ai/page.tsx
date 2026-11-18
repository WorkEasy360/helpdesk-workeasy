'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ANTHROPIC_MODEL_OPTIONS,
  PERMISSIONS,
  aiSettingsSchema,
  type AiSettingsFormValues,
  type AiSettingsInput,
} from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { aiService } from '@/services/ai.service';
import { useAuthStore } from '@/stores/auth.store';
import type { AiSettingsDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';

const FEATURES = [
  { name: 'summaryEnabled', label: 'Conversation summary' },
  { name: 'sentimentEnabled', label: 'Customer sentiment' },
  { name: 'intentEnabled', label: 'Intent, category and priority' },
  { name: 'suggestedReplyEnabled', label: 'Suggested reply' },
] as const;

function toForm(settings: AiSettingsDto): AiSettingsFormValues {
  return {
    provider: settings.provider,
    model: settings.model,
    isEnabled: settings.isEnabled,
    summaryEnabled: settings.summaryEnabled,
    sentimentEnabled: settings.sentimentEnabled,
    intentEnabled: settings.intentEnabled,
    suggestedReplyEnabled: settings.suggestedReplyEnabled,
    autoAnalyse: settings.autoAnalyse,
    assistantDailyLimit: settings.assistantDailyLimit,
    monthlyTokenBudget: settings.monthlyTokenBudget,
    promptGuidance: settings.promptGuidance ?? '',
  };
}

const numberFormat = new Intl.NumberFormat();

function formatCost(costMicros: number) {
  return `$${(costMicros / 1_000_000).toFixed(4)}`;
}

export default function AiSettingsPage() {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const editable = can(PERMISSIONS.AI_MANAGE);
  const [apiKey, setApiKey] = useState('');

  const settings = useQuery({ queryKey: ['ai', 'settings'], queryFn: aiService.settings });
  const usage = useQuery({ queryKey: ['ai', 'usage'], queryFn: aiService.usage });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<AiSettingsFormValues, unknown, AiSettingsInput>({
    resolver: zodResolver(aiSettingsSchema),
  });

  useEffect(() => {
    if (settings.data) reset(toForm(settings.data));
  }, [settings.data, reset]);

  const provider = watch('provider');

  const save = useMutation({
    mutationFn: (values: AiSettingsInput) =>
      // An untouched key field leaves the stored key alone; the API never sends it back.
      aiService.updateSettings(apiKey.trim().length > 0 ? { ...values, apiKey: apiKey.trim() } : values),
    onSuccess: async (data) => {
      setApiKey('');
      reset(toForm(data));
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      toast.success('Assistant settings saved');
    },
    onError: (error) =>
      setError('root', {
        message: error instanceof ApiError ? error.message : 'Unable to save the settings.',
      }),
  });

  const test = useMutation({
    mutationFn: aiService.test,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      toast.success(
        `${result.provider} answered on ${result.model} (${result.usage.inputTokens + result.usage.outputTokens} tokens)`,
      );
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'The provider did not answer.'),
  });

  const clearKey = useMutation({
    mutationFn: () => aiService.updateSettings({ apiKey: '' }),
    onSuccess: async (data) => {
      reset(toForm(data));
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      toast.success('API key removed');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to remove the key.'),
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) {
    return <ErrorState message="Unable to load the assistant settings." onRetry={() => settings.refetch()} />;
  }

  const current = settings.data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Assistant</CardTitle>
          <CardDescription>
            The assistant only ever drafts — nothing it produces is sent to a customer or applied to a
            ticket until an agent chooses it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit((values) => save.mutateAsync(values))}
            className="space-y-4"
            noValidate
          >
            <label className="flex items-center gap-2 text-base font-medium">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                disabled={!editable}
                {...register('isEnabled')}
              />
              Enable the assistant for this organization
            </label>

            <Field label="Provider" htmlFor="provider" error={errors.provider?.message}>
              <Select id="provider" disabled={!editable} {...register('provider')}>
                <option value="HEURISTIC">Built-in (no external calls)</option>
                <option value="ANTHROPIC">Anthropic</option>
              </Select>
            </Field>

            {provider === 'ANTHROPIC' ? (
              <>
                <Field label="Model" htmlFor="model" error={errors.model?.message}>
                  <Select id="model" disabled={!editable} {...register('model')}>
                    {ANTHROPIC_MODEL_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} — ${option.inputPerMTok}/${option.outputPerMTok} per MTok
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="API key"
                  htmlFor="apiKey"
                  hint={
                    current.hasApiKey
                      ? 'A key is stored. Leave this blank to keep it.'
                      : 'Required before the assistant can be enabled with Anthropic.'
                  }
                >
                  <Input
                    id="apiKey"
                    type="password"
                    autoComplete="off"
                    placeholder={current.hasApiKey ? '••••••••' : 'sk-ant-…'}
                    disabled={!editable}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </Field>
                {current.hasApiKey && editable ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={clearKey.isPending}
                    onClick={() => clearKey.mutate()}
                  >
                    Remove stored key
                  </Button>
                ) : null}
              </>
            ) : (
              <p className="rounded-md bg-muted px-3 py-2 text-base text-muted-foreground">
                The built-in provider runs entirely inside this deployment. No ticket content leaves the
                server and no credentials are needed.
              </p>
            )}

            <fieldset className="space-y-2">
              <legend className="text-base font-medium">Features</legend>
              {FEATURES.map((feature) => (
                <label key={feature.name} className="flex items-center gap-2 text-base">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    disabled={!editable}
                    {...register(feature.name)}
                  />
                  {feature.label}
                </label>
              ))}
            </fieldset>

            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                disabled={!editable}
                {...register('autoAnalyse')}
              />
              Analyse new tickets and customer replies automatically
            </label>

            <fieldset className="grid gap-2 border-t border-border pt-4">
              <legend className="c-label">Workspace assistant</legend>
              <p className="c-hint">
                The chat button on every page. It answers from this organization&rsquo;s own data and
                prepares changes for an agent to confirm &mdash; it never changes anything on its own.
                It is always on; agents need the <code>ai.use</code> permission to see it.
              </p>
              <p className="c-hint">
                The assistant runs on the model configured for this deployment
                (<code>AI_PROVIDER</code> / <code>AI_MODEL</code> / <code>AI_API_KEY</code>), not on
                the provider and key above &mdash; those are for the per-ticket insights. The only
                assistant setting here is its daily allowance.
              </p>
              <Field
                label="Questions per day"
                htmlFor="assistantDailyLimit"
                error={errors.assistantDailyLimit?.message}
                hint="Shared by the whole organization and reset at midnight UTC. Set 0 for no limit."
              >
                <Input
                  id="assistantDailyLimit"
                  type="number"
                  min={0}
                  disabled={!editable}
                  {...register('assistantDailyLimit')}
                />
              </Field>
            </fieldset>

            <Field
              label="Monthly token budget"
              htmlFor="monthlyTokenBudget"
              error={errors.monthlyTokenBudget?.message}
              hint="A hard stop. Set 0 for no limit."
            >
              <Input
                id="monthlyTokenBudget"
                type="number"
                min={0}
                disabled={!editable}
                {...register('monthlyTokenBudget')}
              />
            </Field>

            <Field
              label="Extra guidance"
              htmlFor="promptGuidance"
              error={errors.promptGuidance?.message}
              hint="Tone or policy notes added to every request, e.g. the products you support."
            >
              <Textarea id="promptGuidance" rows={4} disabled={!editable} {...register('promptGuidance')} />
            </Field>

            {errors.root ? (
              <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
                {errors.root.message}
              </p>
            ) : null}

            {editable ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" loading={isSubmitting} disabled={!isDirty && apiKey.trim().length === 0}>
                  Save changes
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  loading={test.isPending}
                  onClick={() => test.mutate()}
                >
                  Send a test request
                </Button>
              </div>
            ) : (
              <p className="text-base text-muted-foreground">
                You do not have permission to change these settings.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>The result of the last request sent to the provider.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-base">
            <p>
              <span className="text-muted-foreground">Last checked: </span>
              {current.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString() : 'never'}
            </p>
            {current.lastError ? (
              <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-destructive">
                {current.lastError}
              </p>
            ) : (
              <p className="text-muted-foreground">No errors recorded.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usage this month</CardTitle>
            <CardDescription>
              {usage.data ? usage.data.month : 'Tokens and cost recorded against this organization.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usage.isPending ? (
              <LoadingState />
            ) : usage.isError ? (
              <ErrorState message="Unable to load usage." onRetry={() => usage.refetch()} />
            ) : (
              <div className="space-y-3 text-base">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div>
                    <p className="text-muted-foreground">Requests</p>
                    <p className="font-medium">{numberFormat.format(usage.data.calls)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Input</p>
                    <p className="font-medium">{numberFormat.format(usage.data.inputTokens)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Output</p>
                    <p className="font-medium">{numberFormat.format(usage.data.outputTokens)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Cost</p>
                    <p className="font-medium">{formatCost(usage.data.costMicros)}</p>
                  </div>
                </div>

                {usage.data.budgetTokens > 0 ? (
                  <p className="text-muted-foreground">
                    {numberFormat.format(usage.data.inputTokens + usage.data.outputTokens)} of{' '}
                    {numberFormat.format(usage.data.budgetTokens)} budgeted tokens used
                    {usage.data.budgetUsedRatio !== null
                      ? ` (${Math.round(usage.data.budgetUsedRatio * 100)}%)`
                      : ''}
                    .
                  </p>
                ) : (
                  <p className="text-muted-foreground">No monthly budget is set.</p>
                )}

                {usage.data.byType.length > 0 ? (
                  <ul className="divide-y divide-border border-t border-border">
                    {usage.data.byType.map((row) => (
                      <li key={row.type} className="flex items-center justify-between gap-2 py-1.5">
                        <span>{row.type.replace(/_/g, ' ').toLowerCase()}</span>
                        <span className="text-muted-foreground">
                          {numberFormat.format(row.calls)} ·{' '}
                          {numberFormat.format(row.inputTokens + row.outputTokens)} tokens ·{' '}
                          {formatCost(row.costMicros)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">Nothing has been generated yet.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
