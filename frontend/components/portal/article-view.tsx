'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ThumbsDown, ThumbsUp } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { ErrorState, LoadingState } from '@/components/ui/states';

export function PortalArticleView({ slug, articleSlug }: { slug: string; articleSlug: string }) {
  const api = portalService(slug);
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [asked, setAsked] = useState<boolean | null>(null);

  const article = useQuery({
    queryKey: ['portal-article', slug, articleSlug],
    queryFn: () => api.article(articleSlug),
  });

  const feedback = useMutation({
    mutationFn: (isHelpful: boolean) =>
      api.feedback(article.data!.id, { isHelpful, comment: comment || null }),
    onSuccess: async (_result, isHelpful) => {
      setAsked(isHelpful);
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['portal-article', slug, articleSlug] });
      toast.success('Thanks for the feedback');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to send feedback.'),
  });

  if (article.isPending) {
    return <LoadingState />;
  }
  if (article.isError) {
    return (
      <ErrorState
        message={article.error instanceof ApiError ? article.error.message : 'Unable to load this article.'}
      />
    );
  }

  const data = article.data;
  const voted = asked ?? data.myFeedback?.isHelpful ?? null;

  return (
    <>
      <Link className="inline-flex items-center gap-1 text-base text-muted-foreground hover:underline" href={`/help/${slug}/kb`}>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        All articles
      </Link>

      <article className="rounded-lg border border-border bg-background p-6">
        <h1 className="text-xl font-semibold tracking-tight">{data.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {data.category ? `${data.category.name} · ` : ''}
          Updated {formatDateTime(data.updatedAt)}
        </p>
        <div className="mt-5">
          <Markdown content={data.body} />
        </div>
      </article>

      <Card>
        <CardHeader>
          <CardTitle className="text-md">Was this helpful?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {voted !== null ? (
            <p className="text-base text-muted-foreground">
              You marked this article as {voted ? 'helpful' : 'not helpful'}. You can change your answer.
            </p>
          ) : null}
          <Textarea
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Anything we should add? (optional)"
            aria-label="Feedback comment"
          />
          <div className="flex gap-2">
            <Button variant={voted === true ? 'default' : 'outline'} onClick={() => feedback.mutate(true)}>
              <ThumbsUp className="h-4 w-4" aria-hidden />
              Yes
            </Button>
            <Button variant={voted === false ? 'default' : 'outline'} onClick={() => feedback.mutate(false)}>
              <ThumbsDown className="h-4 w-4" aria-hidden />
              No
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              {data.helpfulCount} of {data.helpfulCount + data.notHelpfulCount} found this helpful
            </span>
          </div>
        </CardContent>
      </Card>

      {data.related.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-md">Related articles</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.related.map((related) => (
                <li key={related.id}>
                  <Link className="text-base hover:underline" href={`/help/${slug}/kb/${related.slug}`}>
                    {related.title}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
