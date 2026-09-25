/**
 * Whether a browser Origin may use a chat channel. The channel's `allowedOrigins` lists
 * the sites allowed to embed the widget; empty means any. The product's own frontend
 * is always allowed (the hosted help center embeds the same widget), and a request with
 * no Origin at all — a server, a native app — is not a browser embedding anything, so
 * the check does not apply to it.
 *
 * Entries may be full origins (`https://shop.example.com`), bare hosts
 * (`shop.example.com`, any scheme and default port) or a wildcard for subdomains
 * (`*.example.com`, which does not match `example.com` itself).
 */
export function isWidgetOriginAllowed(
  origin: string | undefined,
  frontendOrigin: string,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === '') {
    return true;
  }
  const actual = parseOrigin(origin);
  if (!actual) {
    // `null` (sandboxed frames, file://) cannot be attributed to any site.
    return allowedOrigins.length === 0;
  }
  if (actual.origin === parseOrigin(frontendOrigin)?.origin) {
    return true;
  }
  if (allowedOrigins.length === 0) {
    return true;
  }
  return allowedOrigins.some((entry) => matches(entry.trim().toLowerCase(), actual));
}

/** `allowedOrigins` as stored in a channel's JSON config, tolerating junk. */
export function allowedOriginsOf(config: unknown): string[] {
  const value = (config as Record<string, unknown> | null)?.['allowedOrigins'];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function matches(entry: string, actual: URL): boolean {
  if (entry.includes('://')) {
    return parseOrigin(entry)?.origin === actual.origin;
  }
  const host = actual.host.toLowerCase();
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === entry;
}
