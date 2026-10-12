import { expect, test, type Page, type Route } from '@playwright/test';
import { WORKEASY360_SSO_ERROR_CODES } from '@digisoft/shared';

/**
 * "Sign in with Workeasy360" in the browser. The Workeasy360 round trip itself is covered end
 * to end against a fake provider in the API suite (backend/api/test/workeasy360-*.e2e-spec.ts);
 * these tests cover what the frontend does with what the API tells it: which sign-in choices
 * the page offers, the error vocabulary, the launcher URL, the access-ended screen, and the
 * two sign-out entries. `/auth/methods` is answered by the test where the real API (which has
 * no Workeasy360 configured here) would answer otherwise.
 */

const unique = Date.now().toString(36);
const password = 'Str0ngPassword1';
const ORGANIZATION = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';

interface Methods {
  password: boolean;
  workeasy360: boolean;
  workeasy360SignOut: boolean;
}

async function answerMethods(page: Page, methods: Methods) {
  await page.route('**/auth/methods', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: methods }) }),
  );
}

const BOTH: Methods = { password: true, workeasy360: true, workeasy360SignOut: false };
const SSO_ONLY: Methods = { password: false, workeasy360: true, workeasy360SignOut: true };

async function registerAndSignIn(page: Page, label: string) {
  await page.goto('/register');
  await page.getByLabel('Organization name').fill(`SSO ${label} ${unique}`);
  await page.getByLabel('Organization address').fill(`sso-${label}-${unique}`);
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Last name').fill('Owner');
  await page.getByLabel('Work email').fill(`sso-${label}-${unique}@example.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
}

test.describe('the sign-in page', () => {
  test('offers only the password form when Workeasy360 is not configured', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toHaveCount(0);
    await expect(page.getByText('Already a Workeasy360 user?')).toHaveCount(0);
  });

  test('offers Continue with Workeasy360 as a plain link, next to the password form, and never starts it by itself', async ({ page }) => {
    await answerMethods(page, BOTH);
    const startRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/workeasy360/start')) startRequests.push(request.url());
    });

    await page.goto('/login');
    await expect(page.getByText('Already a Workeasy360 user?')).toBeVisible();
    const link = page.getByRole('link', { name: 'Continue with Workeasy360' });
    await expect(link).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();

    // A navigation to the API's start route, not a fetch: an <a href> to the API origin.
    const href = await link.getAttribute('href');
    expect(new URL(href!).pathname).toBe('/api/auth/workeasy360/start');
    expect(new URL(href!).searchParams.has('next')).toBe(false);

    // Waiting does not start anything: the page is a choice, not a redirect.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/login$/);
    expect(startRequests).toEqual([]);
  });

  test('carries where the person was heading into the start link', async ({ page }) => {
    await answerMethods(page, BOTH);
    await page.goto('/login?next=%2Ftickets%3Fstatus%3Dopen');
    const href = await page.getByRole('link', { name: 'Continue with Workeasy360' }).getAttribute('href');
    expect(new URL(href!).searchParams.get('next')).toBe('/tickets?status=open');
  });

  test('does not pass an off-site next along (the link falls back to the dashboard)', async ({ page }) => {
    await answerMethods(page, BOTH);
    await page.goto('/login?next=%2F%2Fevil.example');
    const href = await page.getByRole('link', { name: 'Continue with Workeasy360' }).getAttribute('href');
    expect(new URL(href!).searchParams.get('next')).toBeNull();
  });

  test('shows no password form, and no register or forgot-password links, when sign-in is Workeasy360 only', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
    await expect(page.getByLabel('Email address')).toHaveCount(0);
    await expect(page.getByLabel(/^Password/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create an organization' })).toHaveCount(0);
  });

  test('says so, rather than showing an unusable form, when no way in is configured', async ({ page }) => {
    await answerMethods(page, { password: false, workeasy360: false, workeasy360SignOut: false });
    await page.goto('/login');
    await expect(page.getByText('Sign-in is not available on this deployment')).toBeVisible();
    await expect(page.getByLabel('Email address')).toHaveCount(0);
  });

  test('explains every sso_error code, and anything unknown as a failed sign-in', async ({ page }) => {
    await answerMethods(page, BOTH);
    const seen = new Set<string>();
    for (const code of WORKEASY360_SSO_ERROR_CODES) {
      await page.goto(`/login?sso_error=${code}`);
      const alert = page.locator('#main [role="alert"]').first();
      await expect(alert).toBeVisible();
      const text = (await alert.textContent())!.trim();
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toContain('sso_error');
      seen.add(text);
    }
    // Every code has its own message (refused is also the fallback).
    expect(seen.size).toBe(WORKEASY360_SSO_ERROR_CODES.length);

    await page.goto('/login?sso_error=<script>alert(1)</script>');
    await expect(page.locator('#main [role="alert"]').first()).toContainText('could not be completed');
    await expect(page.getByLabel('Email address')).toBeVisible();
  });

  test('keeps the page\'s security policy strict: the start link needs no fetch and no form post', async ({ page }) => {
    await answerMethods(page, BOTH);
    const response = await page.goto('/login');
    const policy = response!.headers()['content-security-policy']!;
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    // connect-src names only this app and the API (and its socket), nothing new.
    const connect = policy.split(';').map((p) => p.trim()).find((p) => p.startsWith('connect-src'))!;
    expect(connect).not.toContain('*');
    expect(connect).not.toMatch(/workeasy360/i);
  });
});

test.describe('the launcher', () => {
  // The API's start route is not configured against a real Workeasy360 in this suite, so after
  // the redirect the browser lands on the sign-in page with the "unavailable" message - which is
  // itself proof that the launcher URL reached the API's start route.
  const startedAndRefused = /\/login\?sso_error=unavailable$/;

  test('/?organization=<uuid> redirects to the API start route with that organization', async ({ page }) => {
    const response = await page.request.get(`/?organization=${ORGANIZATION.toUpperCase()}`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const target = new URL(response.headers()['location']!);
    expect(target.pathname).toBe('/api/auth/workeasy360/start');
    expect(target.searchParams.get('organization')).toBe(ORGANIZATION);
    expect(response.headers()['cache-control']).toContain('no-store');

    await page.goto(`/?organization=${ORGANIZATION}`);
    await expect(page).toHaveURL(startedAndRefused);
  });

  test('...even when a session already exists', async ({ page }) => {
    await registerAndSignIn(page, 'launcher');
    await page.goto(`/?organization=${ORGANIZATION}`);
    await expect(page).toHaveURL(startedAndRefused);
  });

  test('ignores an organization that is not a UUID', async ({ page }) => {
    for (const value of ['not-a-uuid', '3f1f6a3e', `${ORGANIZATION}x`, '']) {
      const response = await page.request.get(`/?organization=${value}`, { maxRedirects: 0 });
      expect(response.headers()['location'] ?? '').not.toContain('workeasy360');
    }
    await page.goto('/?organization=not-a-uuid');
    await expect(page).toHaveURL(/\/login(\?next=%2Fdashboard)?$/);
  });

  test('a plain visit starts nothing', async ({ page }) => {
    const response = await page.request.get('/', { maxRedirects: 0 });
    expect(response.headers()['location'] ?? '').not.toContain('workeasy360');
    await page.goto('/');
    await expect(page).toHaveURL(/\/login(\?next=%2Fdashboard)?$/);
  });
});

test.describe('when access ends while a session lasts', () => {
  test.describe.configure({ mode: 'serial' });

  const messages = [
    { reason: 'ended', title: 'Your access to Easy Help Desk has ended', extra: 'The trial or plan for this organization has ended.', detail: 'expired' },
    { reason: 'read_only', title: 'Easy Help Desk is read-only', extra: undefined, detail: undefined },
    { reason: 'unverified', title: 'Easy Help Desk cannot confirm your access', extra: undefined, detail: undefined },
  ] as const;

  for (const message of messages) {
    test(`the access-ended screen for "${message.reason}" offers Try again and Sign out`, async ({ page }) => {
      await answerMethods(page, BOTH);
      const query = new URLSearchParams({ reason: message.reason, ...(message.detail ? { detail: message.detail } : {}) });
      await page.goto(`/access-ended?${query.toString()}`);
      await expect(page.getByRole('heading', { name: message.title })).toBeVisible();
      if (message.extra) await expect(page.getByText(message.extra)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out of Easy Help Desk and Workeasy360' })).toHaveCount(0);
      if (message.reason === 'read_only') {
        await expect(page.getByRole('link', { name: 'Continue in read-only mode' })).toBeVisible();
      }
    });
  }

  test('the API client sends a refused agent request to the screen, and Sign out ends the session', async ({ page }) => {
    await registerAndSignIn(page, 'ended');
    await page.route('**/api/v1/tickets**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'WORKEASY360_ACCESS_ENDED', message: 'ended', details: { reason: 'expired' } },
        }),
      }),
    );

    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/access-ended\?reason=ended&detail=expired$/);
    await expect(page.getByRole('heading', { name: 'Your access to Easy Help Desk has ended' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    // The session really ended: the app no longer restores it.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('read-only and unverified refusals go to their own screens', async ({ page }) => {
    await registerAndSignIn(page, 'readonly');
    await page.route('**/api/v1/tickets**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'WORKEASY360_READ_ONLY', message: 'read only' } }),
      }),
    );
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/access-ended\?reason=read_only$/);

    await page.unroute('**/api/v1/tickets**');
    await page.route('**/api/v1/tickets**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'WORKEASY360_ACCESS_UNVERIFIED', message: 'unverified' } }),
      }),
    );
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/access-ended\?reason=unverified$/);
  });
});

test.describe('signing out', () => {
  test('offers both entries when Workeasy360 sign-out is available, and the second ends the session first', async ({ page }) => {
    await registerAndSignIn(page, 'signout');
    await answerMethods(page, SSO_ONLY);
    // The API's logout route redirects to Workeasy360 in production; here it just answers.
    let loggedOutLocally = false;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/auth/logout')) loggedOutLocally = true;
    });
    let leftFor: string | null = null;
    await page.route('**/api/auth/workeasy360/logout', (route) => {
      leftFor = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'workeasy360 sign-out' });
    });

    await page.reload();
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Sign out of Easy Help Desk and Workeasy360' }).click();

    await expect.poll(() => leftFor).toContain('/api/auth/workeasy360/logout');
    expect(loggedOutLocally).toBe(true);
    // The local session is gone.
    await page.unroute('**/api/auth/workeasy360/logout');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('offers only Sign out when Workeasy360 sign-out is not configured', async ({ page }) => {
    await registerAndSignIn(page, 'plainsignout');
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out of Easy Help Desk and Workeasy360' })).toHaveCount(0);
  });
});

test.describe('password pages when password sign-in is off', () => {
  test('forgot-password and reset-password say there is nothing to do here', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    await page.goto('/forgot-password');
    await expect(page.getByRole('heading', { name: 'Password sign-in is turned off' })).toBeVisible();
    await page.goto('/reset-password?token=abcdefghijklmnop');
    await expect(page.getByRole('heading', { name: 'Password sign-in is turned off' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
  });
});

test.describe('accessibility and policy', () => {
  test('the sign-in page and the access-ended page each have exactly one h1', async ({ page }) => {
    await answerMethods(page, BOTH);
    await page.goto('/login');
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');

    await answerMethods(page, SSO_ONLY);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    for (const reason of ['ended', 'read_only', 'unverified']) {
      await page.goto(`/access-ended?reason=${reason}`);
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
  });

  test('no page triggers a Content-Security-Policy violation (Zod no longer probes for eval)', async ({ page }) => {
    const violations: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    page.on('console', (message) => {
      if (/content security policy|unsafe-eval|refused to evaluate/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    await answerMethods(page, BOTH);
    for (const url of ['/login', '/register', '/forgot-password', '/access-ended?reason=ended']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      violations.push(...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])));
    }
    expect(violations).toEqual([]);
  });
});

test.describe('signing out can fail', () => {
  test('a failed sign-out is reported and the person is not pretended to be signed out', async ({ page }) => {
    await registerAndSignIn(page, 'failout');
    let attempts = 0;
    await page.route('**/api/v1/auth/logout', (route) => {
      attempts += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":{"code":"INTERNAL_ERROR","message":"x"}}' });
    });
    await page.getByRole('button', { name: /Account menu for/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();

    await expect(page.getByText('Could not sign you out')).toBeVisible();
    expect(attempts).toBe(2); // one retry
    await expect(page).toHaveURL(/\/dashboard$/);

    // Still signed in: a reload restores the session.
    await page.unroute('**/api/v1/auth/logout');
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('the access-ended screen shows the failure inline', async ({ page }) => {
    await registerAndSignIn(page, 'failout2');
    await page.route('**/api/v1/auth/logout', (route) => route.abort());
    await page.goto('/access-ended?reason=ended');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#main [role="alert"]')).toContainText('Could not sign you out');
    await expect(page).toHaveURL(/\/access-ended/);
  });
});

test.describe('a password-era session in SSO-only mode', () => {
  test('the sign-in page explains why a session ended and offers Workeasy360', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    await page.goto('/login?signin=workeasy360');
    await expect(page.getByText('now signs in with Workeasy360')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
  });

  test('an API refusal WORKEASY360_SIGN_IN_REQUIRED sends the person there', async ({ page }) => {
    await registerAndSignIn(page, 'signinreq');
    await page.route('**/api/v1/tickets**', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'WORKEASY360_SIGN_IN_REQUIRED', message: 'sign in' } }),
      }),
    );
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/login\?signin=workeasy360$/);
  });
});
