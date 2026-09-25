const isProduction = process.env.NODE_ENV === 'production';

/** Origin of a URL plus its WebSocket twin (http→ws, https→wss); [] when unset/invalid. */
function originsFor(value) {
  if (!value) return [];
  try {
    const { protocol, host } = new URL(value);
    const ws = protocol === 'https:' ? 'wss:' : 'ws:';
    return [`${protocol}//${host}`, `${ws}//${host}`];
  } catch {
    return [];
  }
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL || (isProduction ? '' : 'http://localhost:4000/api/v1');
const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || apiUrl;
const connectSrc = [...new Set(["'self'", ...originsFor(apiUrl), ...originsFor(socketUrl)])];

/**
 * No page is meant to be framed — the chat widget lives inside the help center, not in
 * an embeddable route — so framing is refused everywhere. If an embeddable widget route
 * is added later, give it its own `frame-ancestors` entry below.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // Next injects inline bootstrap scripts (and the theme script) without a nonce.
  // Dev additionally needs eval for React Refresh.
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  // Help-center logos, avatars and S3 signed URLs come from arbitrary https hosts.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  `connect-src ${connectSrc.join(' ')}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server (.next/standalone/server.js) for the production Docker image.
  output: 'standalone',
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
