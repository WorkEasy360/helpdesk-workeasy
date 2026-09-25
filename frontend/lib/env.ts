/**
 * Public endpoints the browser talks to. `NEXT_PUBLIC_*` values are inlined at build
 * time, so they must be referenced literally here. Localhost fallbacks exist only for
 * local development — a production build without them fails loudly instead of
 * shipping a bundle that quietly calls http://localhost.
 */

const isProduction = process.env.NODE_ENV === 'production';

function resolve(name: string, value: string | undefined, devFallback: string): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, '');
  if (!isProduction) return devFallback;
  throw new Error(
    `${name} is not set. Set it to the public URL of the API before building the frontend ` +
      '(e.g. https://api.example.com/api/v1).',
  );
}

/** Base URL of the REST API, including the version prefix (e.g. https://api.example.com/api/v1). */
export const API_URL = resolve(
  'NEXT_PUBLIC_API_URL',
  process.env.NEXT_PUBLIC_API_URL,
  'http://localhost:4000/api/v1',
);

/**
 * Socket.IO origin. Defaults to the API's origin, which is where the gateway lives
 * unless the deployment splits them.
 */
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL?.trim()
  ? process.env.NEXT_PUBLIC_SOCKET_URL.trim().replace(/\/+$/, '')
  : new URL(API_URL).origin;
