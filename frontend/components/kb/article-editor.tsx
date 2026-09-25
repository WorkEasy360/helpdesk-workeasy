'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Save, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ARTICLE_STATUSES, CONTENT_VISIBILITIES, slugify, type KbArticleInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { kbService } from '@/services/kb.service';
import { formatDateTime } from '@/lib/utils';
import type { KbArticle } from '@/types/api';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { LoadingState } from '@/components/ui/states';

const VISIBILITY_LABELS: Record<string, string> = {
  PUBLIC: 'Anyone',
  PORTAL_USERS: 'Signed-in customers',
  AGENTS_ONLY: 'Agents only',
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'In review',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

interface Draft {
  title: string;
  slug: string;
  summary: string;
  body: string;
  categoryId: string;
  status: string;
  visibility: string;
  keywords: string;
}

const emptyDraft: Draft = {
  title: '',
  slug: '',
  summary: '',
  body: '',
  categoryId: '',
  status: 'DRAFT',
  visibility: 'PUBLIC',
  keywords: '',
};

function toDraft(article: KbArticle): Draft {
  return {
    title: article.title,
    slug: article.slug,
    summary: article.summary ?? '',
    body: article.body,
    categoryId: article.category?.id ?? '',
    status: article.status,
    visibility: article.visibility,
    keywords: article.keywords.join(', '),
  };
}

/** Create and edit screen for one article; `id` of null opens it in create mode. */
export function ArticleEditor({ id }: { id: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(id ? null : emptyDraft);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ['kb-categories'], queryFn: kbService.categories });
  const article = useQuery({
    queryKey: ['kb-article', id],
    queryFn: () => kbService.article(id as string),
    enabled: id !== null,
  });
  const feedback = useQuery({
    queryKey: ['kb-article-feedback', id],
    queryFn: () => kbService.feedback(id as string),
    enabled: id !== null,
  });

  if (article.data && draft === null) {
    setDraft(toDraft(article.data));
  }

  const payload = (values: Draft): KbArticleInput => ({
    title: values.title,
    slug: values.slug ? slugify(values.slug) : slugify(values.title),
    summary: values.summary || null,
    body: values.body,
    categoryId: values.categoryId || null,
    status: values.status as KbArticleInput['status'],
    visibility: values.visibility as KbArticleInput['visibility'],
    keywords: values.keywords
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean),
    seoTitle: null,
    seoDescription: null,
    position: 0,
  });

  const save = useMutation({
    mutationFn: (values: Draft) =>
      id ? kbService.updateArticle(id, payload(values)) : kbService.createArticle(payload(values)),
    onSuccess: async (saved) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-article', saved.id] });
      toast.success('Article saved');
      if (!id) {
        router.replace(`/knowledge-base/${saved.id}`);
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save the article.'),
  });

  const remove = useMutation({
    mutationFn: () => kbService.removeArticle(id as string),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['kb-articles'] });
      toast.success('Article deleted');
      router.replace('/knowledge-base');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Unable to delete.'),
  });

  if (!draft) {
    return <LoadingState label="Loading article…" />;
  }

  const helpful = article.data ? article.data.helpfulCount : 0;
  const notHelpful = article.data ? article.data.notHelpfulCount : 0;

  return (
    <form
      className="grid gap-4 lg:grid-cols-[1fr_20rem]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.title.trim() || !draft.body.trim()) {
          setError('An article needs a title and a body.');
          return;
        }
        save.mutate(draft);
      }}
    >
      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-4 pt-5">
            <Field label="Title" htmlFor="article-title" required>
              <Input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="How to download an invoice"
              />
            </Field>
            <Field
              label="Address"
              htmlFor="article-slug"
              hint={`/help/…/kb/${draft.slug ? slugify(draft.slug) : slugify(draft.title) || 'article'}`}
            >
              <Input
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                placeholder="Leave blank to use the title"
              />
            </Field>
            <Field label="Summary" htmlFor="article-summary" hint="Shown in search results and category listings.">
              <Textarea
                rows={2}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Body</CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={() => setPreview(!preview)}>
              {preview ? <Pencil className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              {preview ? 'Edit' : 'Preview'}
            </Button>
          </CardHeader>
          <CardContent>
            {preview ? (
              <Markdown content={draft.body || '_Nothing to preview yet._'} />
            ) : (
              <Field label="Markdown" htmlFor="article-body" required>
                <Textarea
                  rows={18}
                  className="font-mono text-xs"
                  value={draft.body}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  placeholder={'## Steps\n\n1. Open Billing\n2. Pick the invoice\n'}
                />
              </Field>
            )}
          </CardContent>
        </Card>

        {id && feedback.data && feedback.data.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Reader feedback</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {feedback.data.map((entry) => (
                <div key={entry.id} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={entry.isHelpful ? 'success' : 'warning'}>
                      {entry.isHelpful ? 'Helpful' : 'Not helpful'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : 'Anonymous'} ·{' '}
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                  {entry.comment ? <p className="mt-1 text-muted-foreground">{entry.comment}</p> : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-4 pt-5">
            <Field label="Status" htmlFor="article-status">
              <Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                {ARTICLE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Who can read it" htmlFor="article-visibility">
              <Select
                value={draft.visibility}
                onChange={(event) => setDraft({ ...draft, visibility: event.target.value })}
              >
                {CONTENT_VISIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {VISIBILITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="article-category">
              <Select
                value={draft.categoryId}
                onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
              >
                <option value="">No category</option>
                {(categories.data ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Keywords" htmlFor="article-keywords" hint="Comma separated; matched by portal search.">
              <Input
                value={draft.keywords}
                onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
                placeholder="invoice, billing"
              />
            </Field>

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <div className="space-y-2">
              <Button type="submit" className="w-full" loading={save.isPending}>
                <Save className="h-4 w-4" aria-hidden />
                Save
              </Button>
              {draft.status !== 'PUBLISHED' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  loading={save.isPending}
                  onClick={() => {
                    const published = { ...draft, status: 'PUBLISHED' };
                    setDraft(published);
                    save.mutate(published);
                  }}
                >
                  <Send className="h-4 w-4" aria-hidden />
                  Save and publish
                </Button>
              ) : null}
              {id ? (
                <Button type="button" variant="ghost" className="w-full" onClick={() =>
                    void confirm({
                      title: 'Delete this article?',
                      description: 'It will be removed from the knowledge base and the help center.',
                      confirmLabel: 'Delete article',
                      onConfirm: () => remove.mutateAsync(),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Delete article
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {article.data ? (
          <Card>
            <CardHeader>
              <CardTitle>Performance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-muted-foreground">
              <p>{article.data.viewCount} view(s)</p>
              <p>
                {helpful} helpful · {notHelpful} not helpful
              </p>
              <p>
                {article.data.publishedAt
                  ? `Published ${formatDateTime(article.data.publishedAt)}`
                  : 'Not published yet'}
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </form>
  );
}
