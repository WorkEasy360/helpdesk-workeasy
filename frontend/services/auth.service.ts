import type {
  AuthMethods,
  LoginInput,
  LoginResponse,
  LoginResult,
  RegisterInput,
  UpdateUserInput,
} from '@digisoft/shared';
import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import type { AuthenticatedUser } from '@digisoft/shared';

export const authService = {
  /** May come back asking which organization to sign into — see `LoginResult`. */
  login: (input: LoginInput) => apiPost<LoginResult>('/auth/login', input),
  register: (input: RegisterInput) => apiPost<LoginResponse>('/auth/register', input),
  logout: () => apiPost<{ loggedOut: true }>('/auth/logout'),
  me: () => apiGet<AuthenticatedUser>('/auth/me'),
  /** Self-service profile edit (name, phone, avatar); answers with the refreshed identity. */
  updateMe: (input: Pick<UpdateUserInput, 'firstName' | 'lastName' | 'phone' | 'avatarUrl'>) =>
    apiPatch<AuthenticatedUser>('/auth/me', input),
  /** Which ways in this deployment offers: password, Workeasy360, and Workeasy360 sign-out. */
  methods: () => apiGet<AuthMethods>('/auth/methods'),
  /** Whether new organizations may sign up on this deployment. */
  registrationStatus: () => apiGet<{ enabled: boolean }>('/auth/register'),
  forgotPassword: (input: { email: string; organizationSlug?: string }) =>
    apiPost<{ requested: true }>('/auth/forgot-password', input),
  resetPassword: (input: { token: string; password: string }) =>
    apiPost<{ reset: true }>('/auth/reset-password', input),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    apiPost<{ changed: true }>('/auth/change-password', input),
};
