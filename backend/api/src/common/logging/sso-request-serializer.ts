import { stdSerializers } from 'pino';
import { WORKEASY360_ROUTE_BASE } from '../app-prefix';

const AUTH_ROUTE_BASE = `/${WORKEASY360_ROUTE_BASE}`;

interface SerializedRequest {
  url?: string;
  query?: unknown;
  [key: string]: unknown;
}

/** `/api/auth` itself or anything below it. The router is case-insensitive, so this is too. */
function isAuthRoute(url: string): boolean {
  const path = url.split('?')[0]!.toLowerCase();
  return path === AUTH_ROUTE_BASE || path.startsWith(`${AUTH_ROUTE_BASE}/`);
}

/**
 * The browser-facing sign-in routes (`/api/auth/...`: start, callback, logout) carry things that
 * do not belong in a log line. The callback arrives as `?code=...&state=...` (a code is single
 * use and PKCE-bound, but the state is a secret of that browser's flow), and the start's `next`
 * is the page the person opened, whose query can hold personal data (a search, a filter). So the
 * request logger drops the query string for every request under `/api/auth/`, and for no other.
 */
export function redactSsoCallback(serialized: SerializedRequest): SerializedRequest {
  if (typeof serialized.url === 'string' && isAuthRoute(serialized.url)) {
    serialized.url = serialized.url.split('?')[0]!;
    delete serialized.query;
  }
  return serialized;
}

/** pino-http `serializers.req`: the standard request serializer, minus the query of the sign-in routes. */
export const requestSerializer = stdSerializers.wrapRequestSerializer(
  (serialized) => redactSsoCallback(serialized as unknown as SerializedRequest) as unknown as typeof serialized,
);
