import type {
  AssignTicketInput,
  BulkUpdateTicketsInput,
  BulkUpdateTicketsResponse,
  ChangePriorityInput,
  ChangeStatusInput,
  CreateMessageInput,
  CreateTicketInput,
  LinkTicketInput,
  ListTicketsQuery,
  MergeTicketInput,
  ResolveTicketInput,
  TagInput,
  TicketCategoryInput,
  TicketPriorityInput,
  TicketStatusInput,
  UpdateTicketInput,
} from '@digisoft/shared';
import { apiDelete, apiGet, apiGetPaged, apiPatch, apiPost, http } from '@/lib/api-client';
import { API_URL } from '@/lib/env';
import type {
  TagWithCount,
  TicketAttachment,
  TicketCategory,
  TicketDetail,
  TicketHistoryEntry,
  TicketMessage,
  TicketPriorityConfig,
  TicketQueueSummary,
  TicketStatusConfig,
  TicketSummary,
  TicketTransitions,
} from '@/types/api';

export const ticketsService = {
  list: (params: Partial<ListTicketsQuery>) => apiGetPaged<TicketSummary>('/tickets', { params }),
  summary: () => apiGet<TicketQueueSummary>('/tickets/summary'),
  get: (id: string) => apiGet<TicketDetail>(`/tickets/${id}`),
  create: (input: CreateTicketInput) => apiPost<TicketDetail>('/tickets', input),
  update: (id: string, input: UpdateTicketInput) => apiPatch<TicketDetail>(`/tickets/${id}`, input),
  /** One action over up to BULK_TICKET_LIMIT tickets; each ticket succeeds or fails on its own. */
  bulk: (input: BulkUpdateTicketsInput) =>
    apiPost<BulkUpdateTicketsResponse>('/tickets/bulk', input),
  assign: (id: string, input: AssignTicketInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/assign`, input),
  changeStatus: (id: string, input: ChangeStatusInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/status`, input),
  changePriority: (id: string, input: ChangePriorityInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/priority`, input),
  resolve: (id: string, input: ResolveTicketInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/resolve`, input),
  close: (id: string) => apiPost<TicketDetail>(`/tickets/${id}/close`),
  reopen: (id: string) => apiPost<TicketDetail>(`/tickets/${id}/reopen`),
  setTags: (id: string, tagIds: string[]) =>
    apiPatch<TicketDetail>(`/tickets/${id}/tags`, { tagIds }),
  merge: (id: string, input: MergeTicketInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/merge`, input),
  link: (id: string, input: LinkTicketInput) =>
    apiPost<TicketDetail>(`/tickets/${id}/links`, input),
  unlink: (id: string, linkId: string) => apiDelete<TicketDetail>(`/tickets/${id}/links/${linkId}`),
  follow: (id: string) => apiPost<{ following: boolean }>(`/tickets/${id}/follow`),
  unfollow: (id: string) => apiPost<{ following: boolean }>(`/tickets/${id}/unfollow`),
  remove: (id: string) => apiDelete<{ deleted: true }>(`/tickets/${id}`),

  messages: (id: string) => apiGetPaged<TicketMessage>(`/tickets/${id}/messages`),
  reply: (id: string, input: CreateMessageInput) =>
    apiPost<TicketMessage>(`/tickets/${id}/messages`, input),
  comment: (id: string, input: CreateMessageInput) =>
    apiPost<TicketMessage>(`/tickets/${id}/comments`, input),
  history: (id: string) => apiGetPaged<TicketHistoryEntry>(`/tickets/${id}/history`),
  transitions: (id: string) => apiGet<TicketTransitions>(`/tickets/${id}/transitions`),

  attachments: (id: string) => apiGet<TicketAttachment[]>(`/tickets/${id}/attachments`),
  upload: async (id: string, file: File): Promise<TicketAttachment> => {
    const form = new FormData();
    form.append('file', file);
    const response = await http.post<{ success: true; data: TicketAttachment }>(
      `/tickets/${id}/attachments`,
      form,
      // Let the browser set the multipart boundary itself.
      { headers: { 'Content-Type': undefined as unknown as string } },
    );
    return response.data.data;
  },
  removeAttachment: (attachmentId: string) =>
    apiDelete<{ deleted: true }>(`/attachments/${attachmentId}`),
};

export const ticketConfigService = {
  statuses: () => apiGet<TicketStatusConfig[]>('/ticket-statuses'),
  createStatus: (input: TicketStatusInput) =>
    apiPost<TicketStatusConfig>('/ticket-statuses', input),
  updateStatus: (id: string, input: Partial<TicketStatusInput>) =>
    apiPatch<TicketStatusConfig>(`/ticket-statuses/${id}`, input),
  removeStatus: (id: string) => apiDelete<{ deleted: true }>(`/ticket-statuses/${id}`),

  priorities: () => apiGet<TicketPriorityConfig[]>('/ticket-priorities'),
  createPriority: (input: TicketPriorityInput) =>
    apiPost<TicketPriorityConfig>('/ticket-priorities', input),
  updatePriority: (id: string, input: Partial<TicketPriorityInput>) =>
    apiPatch<TicketPriorityConfig>(`/ticket-priorities/${id}`, input),
  removePriority: (id: string) => apiDelete<{ deleted: true }>(`/ticket-priorities/${id}`),

  categories: () => apiGet<TicketCategory[]>('/ticket-categories'),
  createCategory: (input: TicketCategoryInput) =>
    apiPost<TicketCategory>('/ticket-categories', input),
  removeCategory: (id: string) => apiDelete<{ deleted: true }>(`/ticket-categories/${id}`),

  tags: () => apiGet<TagWithCount[]>('/tags'),
  createTag: (input: TagInput) => apiPost<TagWithCount>('/tags', input),
  removeTag: (id: string) => apiDelete<{ deleted: true }>(`/tags/${id}`),
};

/**
 * Downloads an attachment. The access token lives in memory rather than a cookie, so a
 * plain link would arrive unauthenticated: the file is fetched with the session header
 * and handed to the browser as a blob.
 */
export async function downloadAttachment(attachmentId: string, fileName: string): Promise<void> {
  await downloadFromApi(`/attachments/${attachmentId}/download`, fileName);
}

/** The `?mode=url` answer of an attachment download route. */
interface DownloadLink {
  url: string;
  fileName?: string;
  /** True for an object-storage signed URL; false for an API path that needs the session. */
  direct?: boolean;
}

/**
 * Fetches an authenticated download and saves it.
 *
 * Asks for the link as JSON first (`?mode=url`): object storage answers with a
 * short-lived signed URL the browser opens on its own (no session header, no CORS),
 * while local storage answers with an API path that is then fetched with the session
 * and saved as a blob. An older API that ignores `mode` sends the file itself (or a
 * JSON body carrying `url`), which is handled the way it always was.
 */
export async function downloadFromApi(path: string, fileName: string): Promise<void> {
  const response = await http.get<Blob>(path, {
    params: { mode: 'url' },
    headers: { Accept: 'application/json' },
    responseType: 'blob',
  });
  const blob = response.data;

  const link = blob.type.includes('application/json') ? await readDownloadLink(blob) : null;
  if (!link) {
    // Not a link: the API streamed the file itself.
    saveBlob(blob, fileName);
    return;
  }

  if (link.direct !== false && /^https?:\/\//.test(link.url)) {
    openSignedUrl(link.url, link.fileName ?? fileName);
    return;
  }

  const target = resolveApiUrl(link.url);
  if (!target) {
    throw new Error('The download link points outside the API.');
  }
  const file = await http.get<Blob>(target, { responseType: 'blob' });
  saveBlob(file.data, link.fileName ?? fileName);
}

async function readDownloadLink(blob: Blob): Promise<DownloadLink | null> {
  try {
    const body = JSON.parse(await blob.text()) as { url?: unknown; data?: Record<string, unknown> };
    const source: Record<string, unknown> = body.data ?? body;
    const url = source.url;
    if (typeof url !== 'string' || url.length === 0) return null;
    return {
      url,
      fileName: typeof source.fileName === 'string' ? source.fileName : undefined,
      // An older API only ever put signed URLs in a JSON body.
      direct: typeof source.direct === 'boolean' ? source.direct : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves an API-relative path (e.g. `/api/v1/attachments/:id/download`) against the
 * API origin. Returns null for anything on another origin, so the session header is
 * never sent elsewhere.
 */
function resolveApiUrl(url: string): string | null {
  try {
    const api = new URL(API_URL, window.location.origin);
    const resolved = new URL(url, api.origin);
    return resolved.origin === api.origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function openSignedUrl(url: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // Ignored cross-origin, but honoured when storage shares the app's origin.
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
