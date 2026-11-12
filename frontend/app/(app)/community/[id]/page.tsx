'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Lock, LockOpen, Pin, Send, ThumbsUp, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ModerateTopicInput } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { communityService } from '@/services/community.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/ui/markdown';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { PageHeader } from '@/components/layout/page-header';

export default function AgentTopicPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [body, setBody] = useState('');

  const topic = useQuery({
    queryKey: ['community-topic', params.id],
    queryFn: () => communityService.topic(params.id),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['community-topic', params.id] });
    await queryClient.invalidateQueries({ queryKey: ['community-topics'] });
  };

  const moderate = useMutation({
    mutationFn: (input: ModerateTopicInput) => communityService.moderateTopic(params.id, input),
    onSuccess: async () => {
      await refresh();
      toast.success('Topic updated');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update.'),
  });

  const reply = useMutation({
    mutationFn: () => communityService.reply(params.id, { body }),
    onSuccess: async () => {
      setBody('');
      await refresh();
      toast.success('Reply posted');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to reply.'),
  });

  const moderateReply = useMutation({
    mutationFn: (input: { id: string; moderation?: 'PUBLISHED' | 'REJECTED'; isAnswer?: boolean }) =>
      communityService.moderateReply(input.id, {
        ...(input.moderation ? { moderation: input.moderation } : {}),
        ...(input.isAnswer === undefined ? {} : { isAnswer: input.isAnswer }),
      }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to update the reply.'),
  });

  const removeTopic = useMutation({
    mutationFn: () => communityService.removeTopic(params.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['community-topics'] });
      toast.success('Topic deleted');
      router.replace('/community');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to delete.'),
  });

  if (topic.isPending) {
    return <LoadingState label="Loading topic…" />;
  }
  if (topic.isError) {
    return (
      <ErrorState
        message={topic.error instanceof ApiError ? topic.error.message : 'Unable to load this topic.'}
        onRetry={() => topic.refetch()}
      />
    );
  }

  const data = topic.data;

  return (
    <>
      <PageHeader
        title={data.title}
        description={`${data.category.name} · ${data.viewCount} view(s) · ${data.voteCount} vote(s)`}
        actions={
          <Button asChild variant="outline">
            <Link href="/community">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle>
                  {data.author ? `${data.author.firstName} ${data.author.lastName}` : 'Deleted user'}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{formatDateTime(data.createdAt)}</p>
              </div>
              <Badge variant={data.moderation === 'PUBLISHED' ? 'success' : 'warning'}>
                {data.moderation.charAt(0) + data.moderation.slice(1).toLowerCase()}
              </Badge>
            </CardHeader>
            <CardContent>
              <Markdown content={data.body} />
            </CardContent>
          </Card>

          {data.replies.map((item) => (
            <Card key={item.id} className={item.isAnswer ? 'border-success' : undefined}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">
                    {item.author ? `${item.author.firstName} ${item.author.lastName}` : 'Deleted user'}
                    {item.author?.type === 'AGENT' ? (
                      <Badge className="ml-2" variant="outline">
                        Agent
                      </Badge>
                    ) : null}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(item.createdAt)} · {item.voteCount} vote(s)
                  </p>
                </div>
                <div className="flex gap-1">
                  {item.isAnswer ? <Badge variant="success">Answer</Badge> : null}
                  {item.moderation !== 'PUBLISHED' ? (
                    <Badge variant="warning">{item.moderation.toLowerCase()}</Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Markdown content={item.body} />
                <div className="flex flex-wrap gap-2">
                  {item.moderation !== 'PUBLISHED' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => moderateReply.mutate({ id: item.id, moderation: 'PUBLISHED' })}
                    >
                      <Check className="h-4 w-4" aria-hidden />
                      Approve
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => moderateReply.mutate({ id: item.id, moderation: 'REJECTED' })}
                    >
                      <X className="h-4 w-4" aria-hidden />
                      Reject
                    </Button>
                  )}
                  {!item.isAnswer ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => moderateReply.mutate({ id: item.id, isAnswer: true })}
                    >
                      <ThumbsUp className="h-4 w-4" aria-hidden />
                      Mark as answer
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle>Reply as support</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={5}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Answer the question — Markdown works here."
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
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Moderation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.moderation !== 'PUBLISHED' ? (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => moderate.mutate({ moderation: 'PUBLISHED' })}
              >
                <Check className="h-4 w-4" aria-hidden />
                Approve topic
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => moderate.mutate({ moderation: 'REJECTED' })}
              >
                <X className="h-4 w-4" aria-hidden />
                Reject topic
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => moderate.mutate({ isPinned: !data.isPinned })}
            >
              <Pin className="h-4 w-4" aria-hidden />
              {data.isPinned ? 'Unpin' : 'Pin to top'}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => moderate.mutate({ isLocked: !data.isLocked })}
            >
              {data.isLocked ? <LockOpen className="h-4 w-4" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
              {data.isLocked ? 'Unlock' : 'Lock replies'}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => moderate.mutate({ status: data.status === 'CLOSED' ? 'OPEN' : 'CLOSED' })}
            >
              {data.status === 'CLOSED' ? 'Reopen topic' : 'Close topic'}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() =>
                void confirm({
                  title: 'Delete this topic?',
                  description: 'The topic and all of its replies will be removed.',
                  confirmLabel: 'Delete topic',
                  onConfirm: () => removeTopic.mutateAsync(),
                })
              }
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete topic
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
