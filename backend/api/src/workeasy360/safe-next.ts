/** Where a sign-in lands when the caller named nothing usable. */
export const DEFAULT_NEXT = '/dashboard';

/** Pages a sign-in must never land on (they would bounce straight back into it). */
const AUTH_PAGES = /^\/(login|register|forgot-password|reset-password|verify-email|access-ended)(?:[/?#]|$)/;

const PROBE_ORIGIN = 'http://same-site.invalid';

/**
 * A same-site path to land on after sign-in, or the default. Never another host, never an
 * auth page. A browser strips tabs and newlines from a URL and reads a backslash as a slash,
 * so `/<tab>/evil.example` would become `//evil.example`: whitespace, control characters and
 * backslashes are refused outright rather than normalised.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return DEFAULT_NEXT;
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_NEXT;
  if (hasUnsafeCharacter(value)) return DEFAULT_NEXT;

  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_NEXT;
  }
  if (resolved.origin !== PROBE_ORIGIN) return DEFAULT_NEXT;
  // A percent-encoded slash or backslash that decodes into a protocol-relative form is
  // still harmless as a path, but never let one through the front: refuse what would
  // normalise to a double slash or a dot segment escape.
  if (resolved.pathname.startsWith('//')) return DEFAULT_NEXT;

  if (AUTH_PAGES.test(value) || value.startsWith('/api/') || value === '/api') return DEFAULT_NEXT;

  if (resolved.searchParams.has('organization')) {
    // The app sends any page carrying ?organization= back into this flow (the launcher
    // entry point); landing on one would loop.
    return resolved.pathname === '/' ? DEFAULT_NEXT : resolved.pathname;
  }
  return value;
}

const BACKSLASH = 0x5c;

/**
 * Whitespace of any kind (including the Unicode spaces and line separators), control
 * characters and backslashes. Written as code points so no escape sequence is involved.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === BACKSLASH) return true;
    if (code >= 0x80 && code <= 0x9f) return true; // C1 controls, including NEL
    if (code >= 0x80 && value[index]!.trim() === '') return true; // NBSP, U+2028, U+3000, ...
  }
  return false;
}
