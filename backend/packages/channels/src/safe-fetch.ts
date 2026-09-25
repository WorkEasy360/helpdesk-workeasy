import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIpLiteral, isPrivateAddress } from '@digisoft/shared';

/**
 * Outbound HTTP for URLs a customer or a webhook payload controls. Every hop is
 * checked against the address it actually connects to — the DNS answer is validated
 * inside the socket's own lookup, so a name cannot pass the check and then rebind to
 * an internal address — and redirects are followed by hand so each target is checked
 * again. The response body is capped while streaming rather than after buffering.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Deadline for the whole exchange, redirects included. */
  timeoutMs?: number;
  /** Response bytes to accept. */
  maxBytes?: number;
  /** `error` rejects an oversized body; `truncate` keeps the first `maxBytes`. */
  onOverflow?: 'error' | 'truncate';
  /** Redirects to follow; each target is re-validated. POSTs never follow. */
  maxRedirects?: number;
  /** Address policy; overridable in tests only. Defaults to refusing non-public ranges. */
  isBlockedAddress?: (address: string) => boolean;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The URL that produced this response, after redirects. */
  url: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** Throws `UnsafeUrlError` unless the URL is http(s) and its host is not an internal literal. */
export function assertSafeUrl(
  raw: string,
  isBlocked: (address: string) => boolean = isPrivateAddress,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Refusing ${url.protocol} URL`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Refusing a URL with embedded credentials');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeUrlError('Refusing a loopback host');
  }
  if (isIpLiteral(host) && isBlocked(host)) {
    throw new UnsafeUrlError(`Refusing non-public address ${host}`);
  }
  return url;
}

/** A `lookup` for the socket that refuses to hand back a non-public address. */
export function guardedLookup(isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      // Any internal answer poisons the name: the socket may pick any of them.
      const blocked = list.find((entry) => isBlocked(entry.address));
      if (list.length === 0 || blocked) {
        callback(
          new UnsafeUrlError(
            `Refusing ${hostname}: it resolves to non-public address ${blocked?.address ?? '(none)'}`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (err: null, all: LookupAddress[]) => void)(null, list);
        return;
      }
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(
  url: URL,
  options: Required<Pick<SafeFetchOptions, 'maxBytes' | 'onOverflow' | 'isBlockedAddress'>> &
    SafeFetchOptions,
  signal: AbortSignal,
  followRedirect: boolean,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        lookup: guardedLookup(options.isBlockedAddress),
        // No pooled sockets: every connection goes through the guarded lookup.
        agent: false,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // A redirect's body is irrelevant; do not spend the byte budget on it.
        if (followRedirect && status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }

        const declared = Number(response.headers['content-length']);
        if (options.onOverflow === 'error' && Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          reject(new ResponseTooLargeError(options.maxBytes));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          if (truncated) {
            return;
          }
          received += chunk.length;
          if (received > options.maxBytes) {
            if (options.onOverflow === 'error') {
              response.destroy();
              reject(new ResponseTooLargeError(options.maxBytes));
              return;
            }
            chunks.push(chunk.subarray(0, chunk.length - (received - options.maxBytes)));
            truncated = true;
            response.destroy();
            resolve({ status, headers: response.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status, headers: response.headers, body: Buffer.concat(chunks), truncated });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const resolved = {
    ...options,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    onOverflow: options.onOverflow ?? 'error',
    isBlockedAddress: options.isBlockedAddress ?? isPrivateAddress,
  } as const;
  const isPost = (options.method ?? 'GET') !== 'GET';
  const maxRedirects = isPost ? 0 : (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let url = assertSafeUrl(rawUrl, resolved.isBlockedAddress);
    for (let redirects = 0; ; redirects += 1) {
      const hop = await requestOnce(url, resolved, controller.signal, maxRedirects > 0).catch(
        (error: unknown) => {
          if (controller.signal.aborted) {
            throw new Error(`Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
          }
          throw error;
        },
      );
      const location = hop.headers.location;
      if (maxRedirects > 0 && hop.status >= 300 && hop.status < 400 && location) {
        if (redirects >= maxRedirects) {
          throw new UnsafeUrlError(`Too many redirects (limit ${maxRedirects})`);
        }
        url = assertSafeUrl(new URL(location, url).toString(), resolved.isBlockedAddress);
        continue;
      }
      return {
        status: hop.status,
        ok: hop.status >= 200 && hop.status < 300,
        headers: hop.headers,
        body: hop.body,
        url: url.toString(),
        truncated: hop.truncated,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
