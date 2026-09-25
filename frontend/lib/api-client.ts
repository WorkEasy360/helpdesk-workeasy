'use client';

import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiFailure, ApiResponse, PageMeta } from '@digisoft/shared';
import { API_URL } from '@/lib/env';

const BASE_URL = API_URL;

/**
 * The access token lives in memory only — never localStorage — so an XSS payload
 * cannot read it back out of storage. The refresh token is an http-only cookie the
 * browser attaches to the auth routes on its own.
 *
 * Two sessions can exist in one browser: the agent app's (`ds_refresh`, renewed at
 * `/auth/refresh`) and a help center customer's (`ds_portal_refresh`, scoped to and
 * renewed at `/portal/:slug/auth/refresh`). A page only ever runs one of them, so the
 * access token is a single slot; what differs is where it is renewed and who is told
 * when renewal fails.
 */
let accessToken: string | null = null;
const refreshPromises = new Map<string, Promise<string | null>>();
let onSessionLost: (() => void) | null = null;
let onPortalSessionLost: (() => void) | null = null;
/** The help center whose customer session this page runs, if any. */
let activePortalSlug: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when the agent session cannot be renewed. */
export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

/**
 * Marks this page as running a help center customer session: refreshes go to that
 * help center's portal auth routes and a failed refresh is reported to `onLost`
 * instead of the agent app. Pass `null` to hand the page back to the agent session.
 */
export function setPortalSession(slug: string | null, onLost: (() => void) | null = null): void {
  activePortalSlug = slug;
  onPortalSessionLost = slug ? onLost : null;
}

export interface RefreshOptions {
  /**
   * Renew a help center customer session instead of the agent session. Defaults to the
   * active portal session, if this page runs one.
   */
  portalSlug?: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return config;
});

function refreshPath(portalSlug: string | null): string {
  return portalSlug ? `/portal/${encodeURIComponent(portalSlug)}/auth/refresh` : '/auth/refresh';
}

/**
 * Exchanges the matching refresh cookie for a new access token. Concurrent callers for
 * the same session share one request, since the refresh token rotates on every use.
 */
async function refreshAccessToken(options: RefreshOptions = {}): Promise<string | null> {
  const portalSlug = options.portalSlug === undefined ? activePortalSlug : options.portalSlug;
  const path = refreshPath(portalSlug);

  let pending = refreshPromises.get(path);
  if (!pending) {
    pending = axios
      .post<ApiResponse<{ accessToken: string }>>(`${BASE_URL}${path}`, {}, { withCredentials: true })
      .then((response) => {
        const body = response.data;
        const token = body.success ? body.data.accessToken : null;
        setAccessToken(token);
        return token;
      })
      .catch(() => {
        setAccessToken(null);
        return null;
      })
      .finally(() => {
        refreshPromises.delete(path);
      });
    refreshPromises.set(path, pending);
  }
  return pending;
}

/** `/portal/:slug/...` requests belong to that help center's customer session. */
function portalSlugOf(url: string | undefined): string | null {
  const match = url?.match(/^\/portal\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * Requests whose 401 must not trigger a refresh: the auth routes themselves, and chat
 * visitor calls, whose only credential is their own chat token.
 */
function skipsRefresh(config: AxiosRequestConfig): boolean {
  const url = config.url ?? '';
  if (/^(\/portal\/[^/]+)?\/auth\/(refresh|login|logout)/.test(url)) {
    return true;
  }
  return AxiosHeaders.from(config.headers as AxiosHeaders).has('x-chat-token');
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiFailure>) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status ?? 0;
    const code = error.response?.data?.error?.code;

    // One transparent refresh attempt, and never on the auth routes themselves. A
    // help center request renews the customer session of that help center; anything
    // else renews whichever session this page runs.
    if (status === 401 && original && !original._retried && !skipsRefresh(original)) {
      original._retried = true;
      const portalSlug = portalSlugOf(original.url) ?? activePortalSlug;
      const token = await refreshAccessToken({ portalSlug });
      if (token) {
        return http.request(original);
      }
      if (portalSlug) {
        if (portalSlug === activePortalSlug) onPortalSessionLost?.();
      } else {
        onSessionLost?.();
      }
    }

    throw new ApiError(
      code ?? 'INTERNAL_ERROR',
      error.response?.data?.error?.message ?? error.message ?? 'Something went wrong',
      status,
      error.response?.data?.error?.details,
    );
  },
);

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const response = await http.get<ApiResponse<T>>(url, config);
  return unwrap(response.data);
}

export interface PagedResult<T> {
  items: T[];
  meta: PageMeta;
}

export async function apiGetPaged<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<PagedResult<T>> {
  const response = await http.get<ApiResponse<T[]>>(url, config);
  const body = response.data;
  if (!body.success) {
    throw new ApiError(body.error.code, body.error.message, 400, body.error.details);
  }
  return {
    items: body.data,
    meta: body.meta ?? { page: 1, pageSize: body.data.length, total: body.data.length, totalPages: 1 },
  };
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const response = await http.post<ApiResponse<T>>(url, data);
  return unwrap(response.data);
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const response = await http.patch<ApiResponse<T>>(url, data);
  return unwrap(response.data);
}

export async function apiDelete<T>(url: string): Promise<T> {
  const response = await http.delete<ApiResponse<T>>(url);
  return unwrap(response.data);
}

function unwrap<T>(body: ApiResponse<T>): T {
  if (!body.success) {
    throw new ApiError(body.error.code, body.error.message, 400, body.error.details);
  }
  return body.data;
}

export { refreshAccessToken };
