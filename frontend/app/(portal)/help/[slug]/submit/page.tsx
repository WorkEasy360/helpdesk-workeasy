'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Send } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import type { PortalForm, WebFormFieldDto } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ArticleSearch } from '@/components/portal/article-search';
import { usePortalSession } from '@/components/portal/portal-session';

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: WebFormFieldDto;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `wf-${field.key}`;
  if (field.type === 'TEXTAREA') {
    return (
      <Field label={field.label} htmlFor={id} required={field.required} hint={field.helpText ?? undefined}>
        <Textarea rows={5} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder ?? ''} />
      </Field>
    );
  }
  if (field.type === 'SELECT') {
    return (
      <Field label={field.label} htmlFor={id} required={field.required} hint={field.helpText ?? undefined}>
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (field.type === 'CHECKBOX') {
    return (
      <label className="flex items-center gap-2 text-base">
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4"
          checked={value === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : '')}
        />
        {field.label}
      </label>
    );
  }
  const inputType =
    field.type === 'EMAIL' ? 'email' : field.type === 'NUMBER' ? 'number' : field.type === 'DATE' ? 'date' : field.type === 'PHONE' ? 'tel' : 'text';
  return (
    <Field label={field.label} htmlFor={id} required={field.required} hint={field.helpText ?? undefined}>
      <Input
        type={inputType}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder ?? ''}
      />
    </Field>
  );
}

export default function SubmitRequestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = usePortalSession();

  const [formSlug, setFormSlug] = useState(searchParams.get('form') ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ ticketNumber: number | null; message: string } | null>(null);

  const forms = useQuery({ queryKey: ['portal-forms', slug], queryFn: api.forms });
  const active: PortalForm | undefined =
    forms.data?.find((form) => form.slug === formSlug) ?? forms.data?.[0];

  const submit = useMutation({
    mutationFn: () => api.submitForm(active!.slug, values),
    onSuccess: (result) => {
      setError(null);
      setDone({ ticketNumber: result.ticketNumber, message: result.successMessage });
      setValues({});
    },
    onError: (err) => {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const issues = err.details as { path: string; message: string }[];
        setError(issues.map((issue) => issue.message).join(' · '));
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Unable to send the request.');
    },
  });

  if (forms.isPending) {
    return <LoadingState />;
  }
  if (forms.isError) {
    return (
      <ErrorState
        message={
          forms.error instanceof ApiError ? forms.error.message : 'Unable to load the request form.'
        }
        onRetry={() => forms.refetch()}
      />
    );
  }
  if (!active) {
    return (
      <EmptyState
        title="No request form is available"
        description="The support team has not published a form for this help center yet."
      />
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-md">
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
            Request received
          </CardTitle>
          <CardDescription>{done.message}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-base">
          {done.ticketNumber ? <p>Your reference is #{done.ticketNumber}.</p> : null}
          <div className="flex gap-2">
            {session.status === 'signed-in' ? (
              <Button asChild>
                <Link href={`/help/${slug}/tickets`}>View my requests</Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href={`/help/${slug}/register`}>Create an account to follow it</Link>
              </Button>
            )}
            <Button variant="outline" onClick={() => setDone(null)}>
              Submit another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <h1 className="text-lg font-semibold tracking-tight">Submit a request</h1>
        <p className="text-base text-muted-foreground">
          Many questions are already answered in the knowledge base — try a search first.
        </p>
        <ArticleSearch slug={slug} placeholder="Describe your problem in a few words…" />
      </div>

      {forms.data && forms.data.length > 1 ? (
        <Field label="What is this about?" htmlFor="form-picker">
          <Select
            value={active.slug}
            onChange={(event) => {
              setFormSlug(event.target.value);
              setValues({});
              router.replace(`/help/${slug}/submit?form=${event.target.value}`);
            }}
          >
            {forms.data.map((form) => (
              <option key={form.id} value={form.slug}>
                {form.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-md">{active.name}</CardTitle>
          {active.description ? <CardDescription>{active.description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate();
            }}
          >
            {active.fields
              .filter(
                (field) =>
                  // A signed-in customer is already identified; don't ask again.
                  session.status !== 'signed-in' || !['name', 'email'].includes(field.mapsTo),
              )
              .map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ''}
                  onChange={(value) => setValues({ ...values, [field.key]: value })}
                />
              ))}

            {error ? (
              <p role="alert" className="rounded-md bg-error-soft px-3 py-2 text-base text-destructive">
                {error}
              </p>
            ) : null}

            <Button type="submit" loading={submit.isPending}>
              <Send className="h-4 w-4" aria-hidden />
              {active.submitLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
