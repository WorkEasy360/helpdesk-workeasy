import type {
  ArticleFeedbackInput,
  CreateReplyInput,
  CreateTopicInput,
  ListTopicsQuery,
  PortalCreateTicketInput,
  PortalLoginInput,
  PortalRegisterInput,
  PortalReplyInput,
} from '@digisoft/shared';
import { apiDelete, apiGet, apiGetPaged, apiPost, http } from '@/lib/api-client';
import type { LoginResponse } from '@digisoft/shared';
import { downloadFromApi } from '@/services/tickets.service';
import type {
  CommunityCategory,
  CommunityReply,
  CommunityTopic,
  CommunityTopicDetail,
  PortalArticle,
  PortalArticleCard,
  PortalCategory,
  PortalConfig,
  PortalForm,
  PortalProfile,
  PortalTicket,
  PortalTicketOptions,
  PortalTicketSummary,
} from '@/types/api';

/**
 * Customer-facing API. Every call is addressed by help center slug, so one deployment
 * serves every organization's portal without a build step per tenant.
 */
export const portalService = (slug: string) => {
  const base = `/portal/${slug}`;
  return {
    config: () => apiGet<PortalConfig>(base),

    categories: () => apiGet<PortalCategory[]>(`${base}/kb/categories`),
    articles: (params: { page?: number; pageSize?: number; categoryId?: string }) =>
      apiGetPaged<PortalArticleCard>(`${base}/kb/articles`, { params }),
    article: (idOrSlug: string) => apiGet<PortalArticle>(`${base}/kb/articles/${idOrSlug}`),
    search: (q: string, limit = 8) =>
      apiGet<PortalArticleCard[]>(`${base}/kb/search`, { params: { q, limit } }),
    feedback: (articleId: string, input: ArticleFeedbackInput) =>
      apiPost<{ id: string; helpfulCount: number; notHelpfulCount: number }>(
        `${base}/kb/articles/${articleId}/feedback`,
        input,
      ),

    forms: () => apiGet<PortalForm[]>(`${base}/forms`),
    form: (formSlug: string) => apiGet<PortalForm>(`${base}/forms/${formSlug}`),
    submitForm: (formSlug: string, values: Record<string, unknown>) =>
      apiPost<{ ticketId: string | null; ticketNumber: number | null; successMessage: string }>(
        `${base}/forms/${formSlug}/submit`,
        { values },
      ),

    register: (input: PortalRegisterInput) => apiPost<LoginResponse>(`${base}/auth/register`, input),
    login: (input: PortalLoginInput) => apiPost<LoginResponse>(`${base}/auth/login`, input),
    /** Ends the customer session and clears this help center's refresh cookie. */
    logout: () => apiPost<{ loggedOut: true }>(`${base}/auth/logout`),
    forgotPassword: (email: string) =>
      apiPost<{ requested: true }>(`${base}/auth/forgot-password`, { email }),
    resetPassword: (token: string, password: string) =>
      apiPost<{ reset: true }>(`${base}/auth/reset-password`, { token, password }),
    me: () => apiGet<PortalProfile>(`${base}/auth/me`),

    tickets: (params: { page?: number; pageSize?: number; open?: boolean; q?: string }) =>
      apiGetPaged<PortalTicketSummary>(`${base}/tickets`, { params }),
    ticket: (id: string) => apiGet<PortalTicket>(`${base}/tickets/${id}`),
    ticketOptions: () => apiGet<PortalTicketOptions>(`${base}/tickets/options`),
    createTicket: (input: PortalCreateTicketInput) =>
      apiPost<PortalTicket>(`${base}/tickets`, input),
    replyToTicket: (id: string, input: PortalReplyInput) =>
      apiPost<PortalTicket>(`${base}/tickets/${id}/replies`, input),
    closeTicket: (id: string) => apiPost<PortalTicket>(`${base}/tickets/${id}/close`),
    uploadAttachment: async (ticketId: string, file: File) => {
      const body = new FormData();
      body.append('file', file);
      const response = await http.post<{ success: true; data: { id: string; fileName: string } }>(
        `${base}/tickets/${ticketId}/attachments`,
        body,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return response.data.data;
    },
    attachmentUrl: (attachmentId: string) =>
      `${base}/tickets/attachments/${attachmentId}/download`,
    /** Authenticated download: a plain link would reach the API without the session header. */
    downloadAttachment: (attachmentId: string, fileName: string) =>
      downloadFromApi(`${base}/tickets/attachments/${attachmentId}/download`, fileName),

    communityCategories: () => apiGet<CommunityCategory[]>(`${base}/community/categories`),
    topics: (params: Partial<ListTopicsQuery>) =>
      apiGetPaged<CommunityTopic>(`${base}/community/topics`, { params }),
    topic: (idOrSlug: string) => apiGet<CommunityTopicDetail>(`${base}/community/topics/${idOrSlug}`),
    createTopic: (input: CreateTopicInput) =>
      apiPost<CommunityTopic>(`${base}/community/topics`, input),
    replyToTopic: (topicId: string, input: CreateReplyInput) =>
      apiPost<CommunityReply>(`${base}/community/topics/${topicId}/replies`, input),
    voteTopic: (topicId: string) =>
      apiPost<{ voted: boolean; voteCount: number }>(`${base}/community/topics/${topicId}/vote`),
    voteReply: (replyId: string) =>
      apiPost<{ voted: boolean; voteCount: number }>(`${base}/community/replies/${replyId}/vote`),
    acceptAnswer: (replyId: string) =>
      apiPost<CommunityReply>(`${base}/community/replies/${replyId}/accept`),
    removeTopic: (topicId: string) =>
      apiDelete<{ deleted: true }>(`${base}/community/topics/${topicId}`),
  };
};
