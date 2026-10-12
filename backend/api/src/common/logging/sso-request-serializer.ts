import { stdSerializers } from 'pino';
import { WORKEASY360_CALLBACK_PATH } from '../app-prefix';

const CALLBACK_PREFIX = `/${WORKEASY360_CALLBACK_PATH}`;

interface SerializedRequest {
  url?: string;
  query?: unknown;
  [key: string]: unknown;
}

/**
 * The Workeasy360 callback arrives as `?code=...&state=...`. Neither belongs in a log line
 * (a code is single use and PKCE-bound, but the state is a secret of that browser's flow), so
 * the request logger drops the query string for that route - and only that route.
 */
export function redactSsoCallback(serialized: SerializedRequest): SerializedRequest {
  if (typeof serialized.url === 'string' && serialized.url.startsWith(CALLBACK_PREFIX)) {
    serialized.url = serialized.url.split('?')[0]!;
    delete serialized.query;
  }
  return serialized;
}

/** pino-http `serializers.req`: the standard request serializer, minus the SSO callback's secrets. */
export const requestSerializer = stdSerializers.wrapRequestSerializer(
  (serialized) => redactSsoCallback(serialized as unknown as SerializedRequest) as unknown as typeof serialized,
);
