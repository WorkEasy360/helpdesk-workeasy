import { Workeasy360Error } from './errors';

export interface TransportResponse {
  status: number;
  /** Parsed JSON object, or `{}` when the reply was empty, not JSON, or not an object. */
  body: Record<string, unknown>;
}

/** (method, url, form fields or undefined) -> status and parsed JSON body. */
export type Transport = (
  method: 'GET' | 'POST',
  url: string,
  form?: Record<string, string>,
) => Promise<TransportResponse>;

/** Every outbound call is bounded: a provider that hangs must not hang a sign-in. */
export const HTTP_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface FetchTransportOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The production transport: Node's fetch, TLS-verified, bounded by a timeout and a body
 * size cap, redirects refused. Only ever called with URLs derived from the configured
 * issuer or named by its discovery document, never with anything a browser sent.
 */
export function fetchTransport(options: FetchTransportOptions = {}): Transport {
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  return async (method, url, form) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Workeasy360Error('provider_unavailable', 'refusing an unparsable URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Workeasy360Error('provider_unavailable', `refusing non-HTTP URL ${parsed.protocol}`);
    }
    try {
      const response = await doFetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
      const raw = await readCapped(response);
      let body: unknown = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
      return { status: response.status, body: isObject ? (body as Record<string, unknown>) : {} };
    } catch (error) {
      if (error instanceof Workeasy360Error) throw error;
      const name = error instanceof Error ? error.name : 'Error';
      throw new Workeasy360Error('provider_unavailable', `${method} failed (${name})`);
    }
  };
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Workeasy360Error('provider_unavailable', 'reply exceeds the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
