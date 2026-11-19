import { expect, test } from '@playwright/test';
import {
  AUTO_START_WINDOW_MS,
  autoStartCookieName,
  beginAutoStart,
  clearLoopGuard,
  clearSignedOutMarker,
  completeSignIn,
  isSafeNextPath,
  isSsoOnly,
  markSignedOut,
  signInPageFor,
  signedOutCookieName,
  startUrlFor,
  type CookieEnv,
} from '@/lib/auto-sign-in';
import { API_ORIGIN, SIGN_IN_REQUIRED_CODE, refreshFailureOutcome } from '@/lib/sso';

/**
 * Opening Easy Help Desk directly (integration guide 6b): when to start the Workeasy360
 * sign-in by itself. No browser needed; the cookie jar is a small fake with a clock. The
 * same rules are exercised in a real browser in workeasy360-direct-visit.spec.ts.
 */

const SSO_ONLY = { password: false, workeasy360: true } as const;

interface StoredCookie {
  value: string;
  expiresAt: number | null;
}

function fakeBrowser({ secure = false, refuseCookies = false } = {}) {
  let now = 1_700_000_000_000;
  const jar = new Map<string, StoredCookie>();
  const written: string[] = [];
  // Copies of a cookie the browser also holds under another path or domain (document.cookie lists
  // them all, in an order we do not control), such as one a sibling subdomain planted.
  const extra: string[] = [];
  const env: CookieEnv = {
    read: () =>
      [
        ...extra,
        ...[...jar.entries()]
          .filter(([, cookie]) => cookie.expiresAt === null || cookie.expiresAt > now)
          .map(([name, cookie]) => `${name}=${cookie.value}`),
      ].join('; '),
    write: (cookie) => {
      written.push(cookie);
      if (refuseCookies) return;
      const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
      const equals = pair.indexOf('=');
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
      if (!maxAge) {
        jar.set(name, { value, expiresAt: null });
        return;
      }
      const seconds = Number(maxAge.split('=')[1]);
      if (seconds <= 0) jar.delete(name);
      else jar.set(name, { value, expiresAt: now + seconds * 1000 });
    },
    now: () => now,
    secure,
  };
  return {
    env,
    written,
    extra,
    has: (name: string) => [...jar.keys()].includes(name) && (jar.get(name)!.expiresAt ?? Infinity) > now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function nextOf(url: string): string | null {
  return new URL(url).searchParams.get('next');
}

test.describe('opening an agent page with no session, on an SSO-only deployment', () => {
  test('goes straight to the start route with the page as next, and names no organization', () => {
    const browser = fakeBrowser();
    const decision = beginAutoStart({ methods: SSO_ONLY, page: '/tickets/abc123?tab=notes', env: browser.env });
    expect(decision.start).toBe(true);
    if (!decision.start) return;
    const url = new URL(decision.url);
    expect(url.origin).toBe(API_ORIGIN);
    expect(url.pathname).toBe('/api/auth/workeasy360/start');
    expect(url.searchParams.get('next')).toBe('/tickets/abc123?tab=notes');
    expect(url.searchParams.has('organization')).toBe(false);
  });

  test('works the same for the home page the app redirects to, and a deep page', () => {
    for (const page of ['/dashboard', '/settings/profile', '/tickets?status=open&page=2', '/community/42']) {
      const decision = beginAutoStart({ methods: SSO_ONLY, page, env: fakeBrowser().env });
      expect(decision.start).toBe(true);
      expect(decision.start && nextOf(decision.url)).toBe(page);
    }
  });

  test('reads SSO-only from /auth/methods: no password and Workeasy360 on', () => {
    expect(isSsoOnly({ password: false, workeasy360: true })).toBe(true);
    expect(isSsoOnly({ password: true, workeasy360: true })).toBe(false);
    expect(isSsoOnly({ password: true, workeasy360: false })).toBe(false);
    expect(isSsoOnly({ password: false, workeasy360: false })).toBe(false);
    expect(isSsoOnly(null)).toBe(false);
    expect(isSsoOnly(undefined)).toBe(false);
  });

  test('is not done when the deployment also has password sign-in, or when /auth/methods is unreadable', () => {
    for (const methods of [
      { password: true, workeasy360: true },
      { password: true, workeasy360: false },
      { password: false, workeasy360: false },
      null,
      undefined,
    ]) {
      const browser = fakeBrowser();
      const decision = beginAutoStart({ methods, page: '/dashboard', env: browser.env });
      expect(decision).toEqual({ start: false, reason: 'not_sso_only' });
      // ... and it left nothing behind that could suppress a later start.
      expect(browser.written).toEqual([]);
    }
  });

  test('does nothing without a browser to remember in', () => {
    expect(beginAutoStart({ methods: SSO_ONLY, page: '/dashboard', env: null })).toEqual({
      start: false,
      reason: 'no_browser',
    });
  });
});

test.describe('the sign-in page never starts a sign-in', () => {
  test('whatever its query, including after a refusal', () => {
    for (const page of [
      '/login',
      '/login?sso_error=expired',
      '/login?sso_error=cancelled&next=%2Ftickets',
      '/login?signin=workeasy360',
      '/login?next=%2Fdashboard',
      '/login/',
      '/register',
      '/forgot-password',
      '/reset-password?token=abcdefghijklmnop',
      '/access-ended',
      '/access-ended?reason=ended&detail=expired',
    ]) {
      const browser = fakeBrowser();
      expect(beginAutoStart({ methods: SSO_ONLY, page, env: browser.env })).toEqual({
        start: false,
        reason: 'sign_in_page',
      });
      expect(browser.written).toEqual([]);
    }
  });

  test('does not mistake a longer first segment for a sign-in page', () => {
    const decision = beginAutoStart({ methods: SSO_ONLY, page: '/loginhelp', env: fakeBrowser().env });
    expect(decision.start).toBe(true);
  });
});

const start = (browser: ReturnType<typeof fakeBrowser>, page = '/dashboard') =>
  beginAutoStart({ methods: SSO_ONLY, page, env: browser.env });

test.describe('after the person signed out of the Help Desk in this browser', () => {
  test('a session cookie (no Max-Age, no Expires) suppresses automatic starts, in every tab', () => {
    const browser = fakeBrowser();
    markSignedOut(browser.env);

    expect(browser.written).toEqual(['hd_signed_out=1; Path=/; SameSite=Lax']); // plain http, as in local development
    expect(browser.written[0]).not.toMatch(/max-age|expires|domain/i);

    expect(start(browser)).toEqual({ start: false, reason: 'signed_out' });
    // Hours later, and from another page: it holds until the next sign-in.
    browser.advance(8 * 3600_000);
    expect(start(browser, '/tickets')).toEqual({ start: false, reason: 'signed_out' });
  });

  test('over https it is a __Host- cookie: Secure, Path=/, and no Domain (a sibling subdomain cannot shadow it)', () => {
    const browser = fakeBrowser({ secure: true });
    markSignedOut(browser.env);
    expect(browser.written).toEqual(['__Host-hd_signed_out=1; Path=/; SameSite=Lax; Secure']);
    expect(signedOutCookieName(true)).toBe('__Host-hd_signed_out');
    expect(signedOutCookieName(false)).toBe('hd_signed_out');
    expect(beginAutoStart({ methods: SSO_ONLY, page: '/dashboard', env: browser.env })).toEqual({
      start: false,
      reason: 'signed_out',
    });
  });

  test('a password sign-in (or registration) clears it, so a later visit starts again', () => {
    const browser = fakeBrowser();
    markSignedOut(browser.env);
    expect(start(browser).start).toBe(false);

    completeSignIn(browser.env);
    expect(browser.has(signedOutCookieName(false))).toBe(false);
    expect(start(browser).start).toBe(true);
  });

  test('a refresh that merely succeeded does not clear it: only the loop guard is cleared', () => {
    const browser = fakeBrowser();
    markSignedOut(browser.env);
    clearLoopGuard(browser.env); // what a session bootstrap that found a session does
    expect(browser.has(signedOutCookieName(false))).toBe(true);
    expect(start(browser)).toEqual({ start: false, reason: 'signed_out' });
  });

  test('can be taken back when the server clearly said the person is still signed in', () => {
    const browser = fakeBrowser();
    markSignedOut(browser.env);
    clearSignedOutMarker(browser.env);
    expect(browser.has(signedOutCookieName(false))).toBe(false);
    expect(browser.written[1]).toBe('hd_signed_out=; Path=/; SameSite=Lax; Max-Age=0');
  });

  test('also wins over a start that was already allowed a minute ago', () => {
    const browser = fakeBrowser();
    expect(start(browser).start).toBe(true);
    browser.advance(AUTO_START_WINDOW_MS + 1);
    markSignedOut(browser.env);
    expect(start(browser)).toEqual({ start: false, reason: 'signed_out' });
  });

  test('is set if ANY copy of the cookie says so (over http a copy under another path or domain cannot shadow it)', () => {
    const browser = fakeBrowser();
    // The first copy is an empty one a sibling subdomain planted; ours comes after it.
    browser.extra.push('hd_signed_out=', 'hd_signed_out=0');
    markSignedOut(browser.env);
    expect(browser.env.read().split('; ').filter((part) => part.startsWith('hd_signed_out='))).toHaveLength(3);
    expect(start(browser)).toEqual({ start: false, reason: 'signed_out' });

    // A planted empty copy listed alongside does not hide it either.
    const other = fakeBrowser();
    markSignedOut(other.env);
    other.extra.push('hd_signed_out=');
    expect(start(other)).toEqual({ start: false, reason: 'signed_out' });
  });

  test('over https only the __Host- cookie counts: a planted unprefixed copy neither sets nor hides it', () => {
    const planted = fakeBrowser({ secure: true });
    planted.extra.push('hd_signed_out=1');
    expect(start(planted).start).toBe(true); // an unprefixed copy is not ours

    const ours = fakeBrowser({ secure: true });
    markSignedOut(ours.env);
    ours.extra.push('hd_signed_out=', '__Secure-hd_signed_out=');
    expect(start(ours)).toEqual({ start: false, reason: 'signed_out' });
  });
});

test.describe('the loop guard', () => {
  test('a second automatic start less than 60 seconds after the first shows the sign-in page', () => {
    for (const wait of [0, 1_000, 30_000, AUTO_START_WINDOW_MS - 1]) {
      const fresh = fakeBrowser();
      expect(start(fresh).start).toBe(true);
      fresh.advance(wait);
      expect(start(fresh, '/tickets')).toEqual({ start: false, reason: 'recently_started' });
    }
  });

  test('allows another start once 60 seconds have passed', () => {
    const browser = fakeBrowser();
    expect(start(browser).start).toBe(true);
    browser.advance(AUTO_START_WINDOW_MS);
    expect(start(browser).start).toBe(true);
  });

  test('is a short-lived cookie that records the start before the browser leaves', () => {
    const browser = fakeBrowser();
    expect(browser.has(autoStartCookieName(false))).toBe(false);
    start(browser);
    expect(browser.has(autoStartCookieName(false))).toBe(true);
    expect(browser.written[0]).toMatch(/^hd_w360_auto=\d+; Path=\/; SameSite=Lax; Max-Age=60$/);
    browser.advance(AUTO_START_WINDOW_MS + 1);
    expect(browser.has(autoStartCookieName(false))).toBe(false);
  });

  test('over https it is a __Host- cookie: Secure, Path=/, no Domain', () => {
    const browser = fakeBrowser({ secure: true });
    expect(start(browser).start).toBe(true);
    expect(browser.written[0]).toMatch(/^__Host-hd_w360_auto=\d+; Path=\/; SameSite=Lax; Max-Age=60; Secure$/);
    expect(autoStartCookieName(true)).toBe('__Host-hd_w360_auto');
    expect(start(browser)).toEqual({ start: false, reason: 'recently_started' });
  });

  test('a sign-in, or a session that was found, spends it', () => {
    const signedIn = fakeBrowser();
    start(signedIn);
    completeSignIn(signedIn.env);
    expect(signedIn.has(autoStartCookieName(false))).toBe(false);

    const found = fakeBrowser();
    start(found);
    clearLoopGuard(found.env);
    expect(found.has(autoStartCookieName(false))).toBe(false);
  });

  test('is active if ANY copy of the cookie is recent: a planted old or empty copy cannot bypass it', () => {
    const browser = fakeBrowser();
    expect(start(browser).start).toBe(true);
    browser.advance(10_000);
    // A copy from a sibling subdomain, listed first, holding junk, zero, and a stamp from long ago.
    browser.extra.push('hd_w360_auto=', 'hd_w360_auto=0', 'hd_w360_auto=abc', `hd_w360_auto=${1_700_000_000_000 - 3_600_000}`);
    expect(start(browser, '/tickets')).toEqual({ start: false, reason: 'recently_started' });

    // Only planted junk and an old stamp: nothing recent, so a start is allowed.
    const stale = fakeBrowser();
    stale.extra.push('hd_w360_auto=', 'hd_w360_auto=0', `hd_w360_auto=${1_700_000_000_000 - 3_600_000}`);
    expect(start(stale).start).toBe(true);
  });

  test('over https only the __Host- cookie counts: a planted unprefixed copy cannot bypass or trigger it', () => {
    const browser = fakeBrowser({ secure: true });
    expect(start(browser).start).toBe(true);
    // The planted copies are not the guard's: the guard still holds.
    browser.extra.push('hd_w360_auto=0', 'hd_w360_auto=');
    expect(start(browser)).toEqual({ start: false, reason: 'recently_started' });

    // A recent planted unprefixed copy does not make the guard active either.
    const other = fakeBrowser({ secure: true });
    other.extra.push(`hd_w360_auto=${1_700_000_000_000}`);
    expect(start(other).start).toBe(true);
  });

  test('never starts blind: when the browser will not keep a cookie there is no automatic start', () => {
    const browser = fakeBrowser({ refuseCookies: true });
    expect(start(browser)).toEqual({ start: false, reason: 'cannot_remember' });
  });

  test('a clock that moved backwards counts as just now', () => {
    const browser = fakeBrowser();
    expect(start(browser).start).toBe(true);
    browser.advance(-10 * 60_000);
    expect(start(browser).start).toBe(false);
  });
});

test.describe('the links the "Signing you in" screen offers when it takes long', () => {
  test('Continue goes to the same start URL the automatic start used; the sign-in page carries the page', () => {
    const decision = beginAutoStart({ methods: SSO_ONLY, page: '/settings/profile?tab=notes', env: fakeBrowser().env });
    expect(decision.start && decision.url).toBe(startUrlFor('/settings/profile?tab=notes'));
    expect(signInPageFor('/settings/profile?tab=notes')).toBe('/login?next=%2Fsettings%2Fprofile%3Ftab%3Dnotes');
  });

  test('a hostile page is carried by neither link', () => {
    for (const page of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/\t/evil.example', '/login?x=1']) {
      expect(new URL(startUrlFor(page)).searchParams.has('next')).toBe(false);
      expect(signInPageFor(page)).toBe('/login');
    }
  });
});

test.describe('only "no session at all" may start a sign-in', () => {
  test('a refresh the API answers 401 is no session', () => {
    expect(refreshFailureOutcome(401, 'TOKEN_EXPIRED')).toEqual({ kind: 'no_session' });
    expect(refreshFailureOutcome(401, undefined)).toEqual({ kind: 'no_session' });
  });

  test('a session that must sign in with Workeasy360 again keeps its explanation', () => {
    expect(refreshFailureOutcome(403, SIGN_IN_REQUIRED_CODE)).toEqual({ kind: 'sign_in_required' });
    expect(refreshFailureOutcome(401, SIGN_IN_REQUIRED_CODE)).toEqual({ kind: 'sign_in_required' });
  });

  test('anything else, an outage or a throttle included, is not "no session"', () => {
    for (const [status, code] of [
      [403, 'WORKEASY360_ACCESS_ENDED'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
      [500, 'INTERNAL_ERROR'],
      [502, undefined],
      [0, undefined],
      [undefined, undefined],
    ] as const) {
      expect(refreshFailureOutcome(status, code)).toEqual({ kind: 'unavailable' });
    }
  });
});

test.describe('a hostile page address is never forwarded as next', () => {
  const backslash = String.fromCharCode(92);
  const hostile: [string, string][] = [
    ['a protocol-relative URL', '//evil.example'],
    ['a protocol-relative URL with a path', '//evil.example/dashboard'],
    ['three slashes', '///evil.example'],
    ['a backslash after the slash', `/${backslash}evil.example`],
    ['a backslash anywhere', `/ok${backslash}evil`],
    ['a tab (a browser strips it, leaving //evil)', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['a space', '/ /evil.example'],
    ['a NUL', `/${String.fromCharCode(0)}/evil.example`],
    ['a DEL', `/${String.fromCharCode(0x7f)}/evil.example`],
    ['a next-line control (C1)', `/${String.fromCharCode(0x85)}/evil.example`],
    ['a no-break space', `/${String.fromCharCode(0xa0)}/evil.example`],
    ['a line separator', `/${String.fromCharCode(0x2028)}/evil.example`],
    ['an ideographic space', `/${String.fromCharCode(0x3000)}/evil.example`],
    ['an absolute https URL', 'https://evil.example/'],
    ['an absolute http URL', 'http://evil.example/'],
    ['a scheme-relative address', 'evil.example/path'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a path without a leading slash', 'dashboard'],
    ['an empty address', ''],
    ['an over-long path', `/${'a'.repeat(2048)}`],
    ['the API', '/api/v1/tickets'],
    ['the API start route', '/api/auth/workeasy360/start'],
  ];

  for (const [name, page] of hostile) {
    test(`${name}`, () => {
      expect(isSafeNextPath(page)).toBe(false);
      const decision = beginAutoStart({ methods: SSO_ONLY, page, env: fakeBrowser().env });
      // The visit itself still starts (the API lands on the dashboard); only `next` is dropped.
      expect(decision.start).toBe(true);
      if (decision.start) {
        expect(new URL(decision.url).searchParams.has('next')).toBe(false);
        expect(decision.url).not.toContain('evil');
      }
    });
  }

  test('percent-encoded forms stay inside the site: a browser does not decode them into a host', () => {
    for (const page of ['/%2F%2Fevil.example', `/%5Cevil.example`, '/%09/evil.example', '/%0d%0aLocation:%20https://evil.example']) {
      const decision = beginAutoStart({ methods: SSO_ONLY, page, env: fakeBrowser().env });
      expect(decision.start).toBe(true);
      const forwarded = decision.start ? nextOf(decision.url) : null;
      if (forwarded) {
        expect(new URL(forwarded, 'http://same-site.invalid').origin).toBe('http://same-site.invalid');
        expect(forwarded.startsWith('//')).toBe(false);
      }
    }
  });

  test('ordinary same-site paths are kept, with their query', () => {
    for (const page of ['/tickets', '/tickets/abc123?tab=notes', '/settings/users?page=2&q=ann', '/loginhelp']) {
      expect(isSafeNextPath(page)).toBe(true);
    }
  });
});
