/**
 * Server-side reads of the public API, used only for page metadata. Inside Docker the
 * Next server reaches the API over the internal network (e.g. http://api:4000/api/v1),
 * which differs from the browser-facing NEXT_PUBLIC_API_URL — hence API_INTERNAL_URL.
 * Failures return null: metadata must never take a page down.
 */
import type { PortalArticle, PortalConfig } from '@/types/api';

function serverApiUrl(): string | null {
  const url = process.env.API_INTERNAL_URL?.trim() || process.env.NEXT_PUBLIC_API_URL?.trim();
  if (url) return url.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production' ? null : 'http://localhost:4000/api/v1';
}

async function getPublic<T>(
  path: string,
  revalidate: number,
  headers: Record<string, string> = {},
): Promise<T | null> {
  const base = serverApiUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: 'application/json', ...headers },
      next: { revalidate },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { success?: boolean; data?: T };
    return body.success && body.data ? body.data : null;
  } catch {
    return null;
  }
}

export function fetchPortalConfig(slug: string): Promise<PortalConfig | null> {
  return getPublic<PortalConfig>(`/portal/${encodeURIComponent(slug)}`, 300);
}

/**
 * Anonymous read, so restricted articles resolve to null and fall back to a generic
 * title. `X-Metadata-Only` tells the API not to count this as an article view.
 */
export function fetchPortalArticle(slug: string, articleSlug: string): Promise<PortalArticle | null> {
  return getPublic<PortalArticle>(
    `/portal/${encodeURIComponent(slug)}/kb/articles/${encodeURIComponent(articleSlug)}`,
    3600,
    { 'X-Metadata-Only': '1' },
  );
}
