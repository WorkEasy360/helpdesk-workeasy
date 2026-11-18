'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { ticketsService } from '@/services/tickets.service';
import { useAuthStore } from '@/stores/auth.store';
import { useComposerStore } from '@/stores/composer.store';
import { cn } from '@/lib/utils';
import type { TicketAttachment } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';

type Mode = 'reply' | 'comment';

/**
 * Reply and internal comment share one composer but never share an appearance: the
 * internal mode is amber-tinted and labelled, so an agent can see at a glance whether
 * what they are typing will reach the customer.
 */
export function TicketComposer({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const can = useAuthStore((state) => state.can);
  const canReply = can(PERMISSIONS.TICKET_REPLY);
  const canComment = can(PERMISSIONS.TICKET_COMMENT);

  const [mode, setMode] = useState<Mode>(canReply ? 'reply' : 'comment');
  const [body, setBody] = useState('');
  const draft = useComposerStore((state) => state.draft);
  const clearDraft = useComposerStore((state) => state.clearDraft);

  // A suggested reply lands here as an ordinary draft the agent can edit or delete —
  // it is never sent on their behalf.
  useEffect(() => {
    if (draft && draft.ticketId === ticketId) {
      setBody(draft.body);
      setMode('reply');
      clearDraft();
    }
  }, [draft, ticketId, clearDraft]);
  const [pending, setPending] = useState<TicketAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: () => {
      const payload = { bodyText: body.trim(), attachmentIds: pending.map((file) => file.id) };
      return mode === 'reply'
        ? ticketsService.reply(ticketId, payload)
        : ticketsService.comment(ticketId, payload);
    },
    onSuccess: async () => {
      setBody('');
      setPending([]);
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      await queryClient.invalidateQueries({ queryKey: ['tickets'] });
      toast.success(mode === 'reply' ? 'Reply sent' : 'Comment added');
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Unable to post the message.'),
  });

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await ticketsService.upload(ticketId, file);
        setPending((current) => [...current, uploaded]);
      }
      await queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Unable to upload the file.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (!canReply && !canComment) {
    return (
      <p className="border-t border-border p-4 text-base text-muted-foreground">
        Your role does not allow posting on tickets.
      </p>
    );
  }

  const internal = mode === 'comment';

  return (
    <div
      className={cn(
        'border-t p-3 transition-colors',
        internal ? 'border-warning bg-warning-soft' : 'border-border bg-background',
      )}
    >
      <div role="tablist" aria-label="Message type" className="c-segmented mb-2">
        {canReply ? (
          <button type="button" role="tab" aria-selected={mode === 'reply'} onClick={() => setMode('reply')}>
            Reply to customer
          </button>
        ) : null}
        {canComment ? (
          <button type="button" role="tab" aria-selected={internal} onClick={() => setMode('comment')}>
            Internal comment
          </button>
        ) : null}
      </div>

      {internal ? (
        <p className="mb-2 text-xs font-medium text-warning-text">
          Only agents can see internal comments. The customer never receives them.
        </p>
      ) : null}

      <label htmlFor="composer-body" className="sr-only">
        {internal ? 'Internal comment' : 'Reply to the customer'}
      </label>
      <Textarea
        id="composer-body"
        rows={4}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={internal ? 'Add a note for your team…' : 'Write your reply…'}
        className={cn(internal && 'border-warning')}
      />

      {pending.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {pending.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs"
            >
              <Paperclip className="h-3 w-3" aria-hidden />
              {file.fileName}
              <button
                type="button"
                onClick={() => setPending((current) => current.filter((f) => f.id !== file.id))}
                aria-label={`Remove ${file.fileName}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div>
          <input
            ref={fileInput}
            id="composer-files"
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => void attach(event.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Paperclip className="h-4 w-4" aria-hidden />
            )}
            Attach
          </Button>
        </div>

        <Button
          type="button"
          variant={internal ? 'dark' : 'default'}
          onClick={() => send.mutate()}
          loading={send.isPending}
          disabled={body.trim().length === 0}
        >
          <Send className="h-4 w-4" aria-hidden />
          {internal ? 'Add comment' : 'Send reply'}
        </Button>
      </div>
    </div>
  );
}
