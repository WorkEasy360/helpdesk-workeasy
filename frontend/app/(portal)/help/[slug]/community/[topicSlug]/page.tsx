'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Send, ThumbsUp } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { usePortalSession } from '@/components/portal/portal-session';

export default function PortalTopicPage({
  params,
}: {
  params: Promise<{ slug: string; topicSlug: string }>;
}) {
  const { slug, topicSlug } = use(params);
  const api = portalService(slug);
  const queryClient = useQueryClient();
  const session = usePortalSession();
  const [body, setBody] = useState('');

  const topic = useQuery({
    queryKey: ['portal-topic', slug, topicSlug],
    queryFn: () => api.topic(topicSlug),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['portal-topic', slug, topicSlug] });

  const reply = useMutation({
    mutationFn: () => api.replyToTopic(topic.data!.id, { body }),
    onSuccess: async (created) => {
      setBody('');
      await refresh();
      toast.success(
        created.moderation === 'PENDING' ? 'Posted — it appears once the team approves it.' : 'Reply posted',
      );
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to reply.'),
  });

  const voteTopic = useMutation({
    mutationFn: () => api.voteTopic(topic.data!.id),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to vote.'),
  });

  const voteReply = useMutation({
    mutationFn: (replyId: string) => api.voteReply(replyId),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to vote.'),
  });

  const accept = useMutation({
    mutationFn: (replyId: string) => api.acceptAnswer(replyId),
    onSuccess: async () => {
      await refresh();
      toast.success('Marked as the answer');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to mark the answer.'),
  });

  if (topic.isPending) {
    return <LoadingState />;
  }
  if (topic.isError) {
    return <ErrorState message={topic.error instanceof ApiError ? topic.error.message : 'Unable to load this topic.'} />;
  }

  const data = topic.data;
  const isAuthor = session.profile !== null && data.author?.id === session.profile.id;
  const signedIn = session.status === 'signed-in';

  return (
    <>
      <Link
        className="inline-flex items-center gap-1 text-base text-muted-foreground hover:underline"
        href={`/help/${slug}/community`}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Community
      </Link>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-md">{data.title}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {data.category.name} ·{' '}
              {data.author ? `${data.author.firstName} ${data.author.lastName}` : 'Deleted user'} ·{' '}
              {formatDateTime(data.createdAt)} · {data.viewCount} view(s)
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data.status === 'ANSWERED' ? <Badge variant="success">Answered</Badge> : null}
            {data.moderation === 'PENDING' ? <Badge variant="warning">Awaiting review</Badge> : null}
            <Button
              size="sm"
              variant={data.votedTopic ? 'default' : 'outline'}
              disabled={!signedIn}
              onClick={() => voteTopic.mutate()}
            >
              <ThumbsUp className="h-4 w-4" aria-hidden />
              {data.voteCount}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Markdown content={data.body} />
        </CardContent>
      </Card>

      <div className="space-y-3">
        {data.replies.map((item) => (
          <Card key={item.id} className={item.isAnswer ? 'border-success' : undefined}>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="text-base">
                  {item.author ? `${item.author.firstName} ${item.author.lastName}` : 'Deleted user'}
                  {item.author?.type === 'AGENT' ? (
                    <Badge className="ml-2" variant="outline">
                      Support
                    </Badge>
                  ) : null}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {item.isAnswer ? <Badge variant="success">Answer</Badge> : null}
                {item.moderation === 'PENDING' ? <Badge variant="warning">Awaiting review</Badge> : null}
                <Button
                  size="sm"
                  variant={data.votedReplyIds.includes(item.id) ? 'default' : 'outline'}
                  disabled={!signedIn}
                  onClick={() => voteReply.mutate(item.id)}
                >
                  <ThumbsUp className="h-4 w-4" aria-hidden />
                  {item.voteCount}
                </Button>
                {isAuthor && !item.isAnswer ? (
                  <Button size="sm" variant="outline" onClick={() => accept.mutate(item.id)}>
                    <Check className="h-4 w-4" aria-hidden />
                    Accept
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <Markdown content={item.body} />
            </CardContent>
          </Card>
        ))}
      </div>

      {data.isLocked ? (
        <p className="text-base text-muted-foreground">This topic is locked — no new replies.</p>
      ) : signedIn ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-md">Your reply</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={4}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Share what you know — Markdown works here."
              aria-label="Reply body"
            />
            <div className="flex justify-end">
              <Button disabled={!body.trim()} loading={reply.isPending} onClick={() => reply.mutate()}>
                <Send className="h-4 w-4" aria-hidden />
                Post reply
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <p className="text-base text-muted-foreground">
          <Link className="font-medium hover:underline" href={`/help/${slug}/login`}>
            Sign in
          </Link>{' '}
          to join the conversation.
        </p>
      )}
    </>
  );
}
