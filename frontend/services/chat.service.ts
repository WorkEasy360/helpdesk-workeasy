import type { ListChatSessionsQuery, StartChatInput } from '@digisoft/shared';
import { apiGet, apiGetPaged, apiPost, http } from '@/lib/api-client';
import type { ChatSessionDto, ChatTranscript, ChatWidgetConfig } from '@/types/api';

/** Agent side: the chat inbox. Replies go through the normal ticket endpoints. */
export const chatService = {
  sessions: (params: Partial<ListChatSessionsQuery>) =>
    apiGetPaged<ChatSessionDto>('/chat/sessions', { params }),
  transcript: (id: string) => apiGet<ChatTranscript>(`/chat/sessions/${id}`),
  accept: (id: string) => apiPost<ChatSessionDto>(`/chat/sessions/${id}/accept`),
  end: (id: string) => apiPost<ChatSessionDto>(`/chat/sessions/${id}/end`),
};

/**
 * Visitor side. The session token is sent as a header; it is the only credential a
 * visitor has. The widget keeps it in per-tab sessionStorage so a reload can resume the
 * conversation, and drops it as soon as the chat ends.
 */
export const chatWidgetService = (slug: string) => {
  const base = `/portal/${slug}/chat`;
  return {
    config: () => apiGet<ChatWidgetConfig>(`${base}/config`),
    start: (input: StartChatInput) =>
      apiPost<{ token: string; session: ChatSessionDto; greeting: string | null }>(
        `${base}/start`,
        input,
      ),
    transcript: async (token: string) => {
      const response = await http.get<{ success: true; data: ChatTranscript }>(`${base}/session`, {
        headers: { 'x-chat-token': token },
      });
      return response.data.data;
    },
    send: async (token: string, body: string) => {
      const response = await http.post<{ success: true; data: { id: string } }>(
        `${base}/messages`,
        { body },
        { headers: { 'x-chat-token': token } },
      );
      return response.data.data;
    },
    end: async (token: string, rating?: number) => {
      const response = await http.post<{ success: true; data: ChatSessionDto }>(
        `${base}/end`,
        rating ? { rating } : {},
        { headers: { 'x-chat-token': token } },
      );
      return response.data.data;
    },
  };
};
