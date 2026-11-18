import type { AssistantAnswer, AssistantAskInput, AssistantWelcome } from '@digisoft/shared';
import { apiGet, apiPost } from '@/lib/api-client';

export const assistantService = {
  welcome: () => apiGet<AssistantWelcome>('/assistant'),
  ask: (input: AssistantAskInput) => apiPost<AssistantAnswer>('/assistant', input),
};
