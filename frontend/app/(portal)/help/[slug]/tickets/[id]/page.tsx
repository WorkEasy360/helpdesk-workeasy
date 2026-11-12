'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Paperclip, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api-client';
import { portalService } from '@/services/portal.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { usePortalSession } from '@/components/portal/portal-session';

export default function PortalTicketPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = use(params);
  const api = portalService(slug);
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; fileName: string }[]>([]);

  const router = useRouter();
  const session = usePortalSession();

  const ticket = useQuery({
    queryKey: ['portal-ticket', slug, id],
    queryFn: () => api.ticket(id),
    enabled: session.status === 'signed-in',
  });

  // A signed-out visitor following an emailed link signs in and comes straight back here.
  useEffect(() => {
    if (session.status === 'anonymous') {
      router.replace(`/help/${slug}/login?next=${encodeURIComponent(`tickets/${id}`)}`);
    }
  }, [session.status, router, slug, id]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['portal-ticket', slug, id] });

  const reply = useMutation({
    mutationFn: () => api.replyToTicket(id, { bodyText: body, attachmentIds: attachments.map((file) => file.id) }),
    onSuccess: async () => {
      setBody('');
      setAttachments([]);
      await refresh();
      toast.success('Reply sent');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to send the reply.'),
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAttachment(id, file),
    onSuccess: (file) => setAttachments((current) => [...current, file]),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to upload the file.'),
  });

  const close = useMutation({
    mutationFn: () => api.closeTicket(id),
    onSuccess: async () => {
      await refresh();
      toast.success('Request closed');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Unable to close the request.'),
  });

  if (session.status === 'anonymous') {
    return <LoadingState label="Taking you to sign in…" />;
  }
  if (ticket.isPending) {
    return <LoadingState />;
  }
  if (ticket.isError) {
    return (
      <ErrorState
        message={ticket.error instanceof ApiError ? ticket.error.message : 'Unable to load this request.'}
        onRetry={() => ticket.refetch()}
      />
    );
  }

  const data = ticket.data;

  return (
    <>
      <Link
        className="inline-flex items-center gap-1 text-base text-muted-foreground hover:underline"
        href={`/help/${slug}/tickets`}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        My requests
      </Link>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-md">
              #{data.ticketNumber} · {data.subject}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Raised {formatDateTime(data.createdAt)}
              {data.department ? ` · ${data.department.name}` : ''}
              {data.assignedAgent ? ` · with ${data.assignedAgent.firstName}` : ''}
            </p>
          </div>
          <Badge variant={data.status.isClosed ? 'default' : data.status.isResolved ? 'success' : 'outline'}>
            {data.status.name}
          </Badge>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-base">{data.description}</p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {data.messages.map((message) => {
          const fromAgent = message.direction === 'OUTBOUND';
          const author = fromAgent
            ? message.authorUser
              ? `${message.authorUser.firstName} ${message.authorUser.lastName}`
              : 'Support'
            : message.authorContact
              ? `${message.authorContact.firstName} ${message.authorContact.lastName ?? ''}`.trim()
              : 'You';
          return (
            <Card key={message.id} className={fromAgent ? 'border-l-4 border-l-primary' : undefined}>
              <CardContent className="space-y-2 py-4">
                <p className="text-xs text-muted-foreground">
                  {author} · {formatDateTime(message.createdAt)}
                </p>
                <p className="whitespace-pre-wrap text-base">{message.bodyText}</p>
                {message.attachments.length > 0 ? (
                  <ul className="flex flex-wrap gap-2 pt-1">
                    {message.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                          onClick={() =>
                            api
                              .downloadAttachment(attachment.id, attachment.fileName)
                              .catch((error: unknown) =>
                                toast.error(
                                  error instanceof ApiError && error.status !== 0
                                    ? error.message
                                    : 'Unable to download this file.',
                                ),
                              )
                          }
                        >
                          <Paperclip className="h-3 w-3" aria-hidden />
                          {attachment.fileName}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-md">
            {data.status.isResolved || data.status.isClosed ? 'Still need help?' : 'Add a reply'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={
              data.status.isResolved || data.status.isClosed
                ? 'Replying reopens this request.'
                : 'Add anything that helps us understand the problem.'
            }
            aria-label="Reply"
          />

          {attachments.length > 0 ? (
            <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {attachments.map((file) => (
                <li key={file.id} className="rounded-md border border-border px-2 py-1">
                  {file.fileName}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={!body.trim()} loading={reply.isPending} onClick={() => reply.mutate()}>
              <Send className="h-4 w-4" aria-hidden />
              Send reply
            </Button>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = '';
              }}
            />
            <Button variant="outline" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
              <Paperclip className="h-4 w-4" aria-hidden />
              Attach a file
            </Button>
            {!data.status.isClosed ? (
              <Button variant="ghost" loading={close.isPending} onClick={() => close.mutate()}>
                <Check className="h-4 w-4" aria-hidden />
                Close this request
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
