'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Plus, ThumbsUp } from 'lucide-react';
import { toast } from 'sonner';
import { TOPIC_TYPES, type CreateTopicInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Input, Select, Textarea } from '@/components/ui/input';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';
import { usePortalSession } from '@/components/portal/portal-session';

export default function PortalCommunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const api = portalService(slug);
  const queryClient = useQueryClient();
  const session = usePortalSession();

  const [page, setPage] = useState(1);
  const [categoryId, setCategoryId] = useState('');
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', type: 'QUESTION', categoryId: '' });
  const [error, setError] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ['portal-community-categories', slug], queryFn: api.communityCategories });
  const topics = useQuery({
    queryKey: ['portal-topics', slug, { page, categoryId }],
    queryFn: () => api.topics({ page, pageSize: 10, ...(categoryId ? { categoryId } : {}) }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createTopic({
        title: draft.title,
        body: draft.body,
        type: draft.type as CreateTopicInput['type'],
        categoryId: draft.categoryId || (categories.data?.[0]?.id ?? ''),
      }),
    onSuccess: async (topic) => {
      setComposing(false);
      setDraft({ title: '', body: '', type: 'QUESTION', categoryId: '' });
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['portal-topics', slug] });
      toast.success(
        topic.moderation === 'PENDING' ? 'Posted — it appears once the team approves it.' : 'Topic posted',
      );
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to post the topic.'),
  });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Community</h1>
        {session.status === 'signed-in' ? (
          <Button size="sm" onClick={() => setComposing(!composing)}>
            <Plus className="h-4 w-4" aria-hidden />
            New topic
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href={`/help/${slug}/login?next=community`}>Sign in to post</Link>
          </Button>
        )}
      </div>

      {composing ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-md">Start a topic</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.title.trim().length < 5 || !draft.body.trim()) {
                  setError('Give the topic a title of at least five characters and a description.');
                  return;
                }
                create.mutate();
              }}
            >
              <Field label="Title" htmlFor="topic-title" required>
                <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category" htmlFor="topic-category" required>
                  <Select
                    value={draft.categoryId}
                    onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
                  >
                    <option value="">Choose…</option>
                    {(categories.data ?? []).map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Type" htmlFor="topic-type">
                  <Select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
                    {TOPIC_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.charAt(0) + type.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Details" htmlFor="topic-body" required hint="Markdown works here.">
                <Textarea rows={5} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </Field>
              {error ? <p role="alert" className="text-base text-destructive">{error}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setComposing(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending}>
                  Post topic
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Select
        className="w-full sm:w-64"
        value={categoryId}
        aria-label="Filter by category"
        onChange={(event) => {
          setPage(1);
          setCategoryId(event.target.value);
        }}
      >
        <option value="">All categories</option>
        {(categories.data ?? []).map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </Select>

      {topics.isPending ? (
        <LoadingState />
      ) : topics.data && topics.data.items.length > 0 ? (
        <>
          <div className="space-y-3">
            {topics.data.items.map((topic) => (
              <Card key={topic.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <Link className="font-medium hover:underline" href={`/help/${slug}/community/${topic.slug}`}>
                      {topic.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {topic.category.name} ·{' '}
                      {topic.author ? `${topic.author.firstName} ${topic.author.lastName}` : 'Deleted user'} ·{' '}
                      {formatDateTime(topic.lastActivityAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {topic.status === 'ANSWERED' ? <Badge variant="success">Answered</Badge> : null}
                    {topic.moderation === 'PENDING' ? <Badge variant="warning">Awaiting review</Badge> : null}
                    <span className="inline-flex items-center gap-1">
                      <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                      {topic.voteCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                      {topic.replyCount}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Pagination meta={topics.data.meta} onPageChange={setPage} />
        </>
      ) : (
        <EmptyState title="No topics yet" description="Be the first to ask a question or share an idea." />
      )}
    </>
  );
}
