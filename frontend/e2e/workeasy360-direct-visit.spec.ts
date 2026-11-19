import { expect, test, type Cookie, type Page, type Route } from '@playwright/test';

/**
 * Opening Easy Help Desk directly on an SSO-only deployment (integration guide 6b): a person
 * who types the address with no session arrives at Workeasy360 without seeing the sign-in
 * page. The Workeasy360 round trip itself is not available here (the API has none configured),
 * so these tests answer `/auth/methods` as an SSO-only deployment would, stand in for the API's
 * start route (recording what the browser asked it, and either "completing" the sign-in by
 * handing back the session the test saved, or not), and drive everything else for real: the
 * session refresh, the redirect, the sign-out entries and the cookies they leave. The decision
 * rules themselves are covered one by one in auto-sign-in.spec.ts.
 *
 * Browser check path for a deep page: /settings/profile.
 */

const unique = Date.now().toString(36);
const password = 'Str0ngPassword1';
let counter = 0;

interface Methods {
  password: boolean;
  workeasy360: boolean;
  workeasy360SignOut: boolean;
}

const SSO_ONLY: Methods = { password: false, workeasy360: true, workeasy360SignOut: true };
const BOTH: Methods = { password: true, workeasy360: true, workeasy360SignOut: false };

const START = '**/api/auth/workeasy360/start**';
const SIGNED_OUT_COOKIE = 'hd_signed_out';
const GUARD_COOKIE = 'hd_w360_auto';
const REFRESH_COOKIE = 'ds_refresh';

async function answerMethods(page: Page, methods: Methods) {
  await page.route('**/auth/methods', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: methods }) }),
  );
}

function appOrigin(): string {
  return new URL(test.info().project.use.baseURL!).origin;
}

async function registerAndSignIn(page: Page, label: string) {
  counter += 1;
  const slug = `dv-${label}-${unique}${counter}`;
  const email = `${slug}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Organization name').fill(`Direct ${label} ${unique}${counter}`);
  await page.getByLabel('Organization address').fill(slug);
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Last name').fill('Owner');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible();
  return { slug, email };
}

/** The agent session cookie as it stands now (it rotates on every refresh, so take it last). */
async function currentSession(page: Page): Promise<Cookie> {
  const cookie = (await page.context().cookies()).find((candidate) => candidate.name === REFRESH_COOKIE);
  expect(cookie, 'the agent session cookie').toBeTruthy();
  return cookie!;
}

/** Every main-frame URL the page committed, in order (a replaced history entry is still seen). */
function trackNavigations(page: Page): string[] {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return urls;
}

function visitedSignInPage(urls: string[]): string[] {
  return urls.filter((url) => url.startsWith('http') && new URL(url).pathname === '/login');
}

/**
 * Stands in for the API's start route when Workeasy360 completes silently: records the request,
 * hands the browser the session it had (as the callback would), and sends it to `next`.
 */
async function completeStartsWith(page: Page, session: Cookie): Promise<string[]> {
  const starts: string[] = [];
  await page.route(START, async (route) => {
    const url = new URL(route.request().url());
    starts.push(route.request().url());
    await page.context().addCookies([session]);
    const next = url.searchParams.get('next') ?? '/dashboard';
    await route.fulfill({ status: 302, headers: { location: new URL(next, appOrigin()).toString() } });
  });
  return starts;
}

/** Stands in for the start route when nothing comes of it: records the request and answers. */
async function recordStarts(page: Page, respond?: (route: Route) => Promise<void>): Promise<string[]> {
  const starts: string[] = [];
  await page.route(START, async (route) => {
    starts.push(route.request().url());
    if (respond) return respond(route);
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Workeasy360</h1>' });
  });
  return starts;
}

async function cookieNamed(page: Page, name: string) {
  return (await page.context().cookies()).find((cookie) => cookie.name === name);
}

async function openAccountMenu(page: Page) {
  await page.getByRole('button', { name: /Account menu for/ }).click();
}

function parseColor(value: string): [number, number, number] {
  const numbers = value.match(/-?\d*\.?\d+/g)!.map(Number);
  const scale = value.startsWith('color(') ? 255 : 1;
  return [numbers[0]! * scale, numbers[1]! * scale, numbers[2]! * scale];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: [number, number, number], background: [number, number, number]): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

test.describe('opening an agent page with no session, signed in to Workeasy360 only', () => {
  test('/ and a deep page arrive signed in, and the sign-in page is never shown', async ({ page }) => {
    await registerAndSignIn(page, 'direct');
    await answerMethods(page, SSO_ONLY);

    for (const [visit, expectedPath] of [
      ['/', '/dashboard'],
      ['/settings/profile', '/settings/profile'],
      ['/tickets?status=open', '/tickets'],
    ] as const) {
      const session = await currentSession(page);
      await page.context().clearCookies({ name: REFRESH_COOKIE });
      await page.unroute(START).catch(() => undefined);
      const starts = await completeStartsWith(page, session);
      const urls = trackNavigations(page);

      await page.goto(visit);
      // Arrived: the app is up, signed in, on the page that was asked for.
      await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(new RegExp(`${expectedPath.replace('/', '\\/')}(\\?|$)`));

      expect(starts, `the start route is asked once for ${visit}`).toHaveLength(1);
      const start = new URL(starts[0]!);
      expect(start.pathname).toBe('/api/auth/workeasy360/start');
      expect(start.searchParams.get('next')).toBe(visit === '/' ? '/dashboard' : visit);
      expect(start.searchParams.has('organization')).toBe(false);
      expect(visitedSignInPage(urls), `no sign-in page on the way to ${visit}`).toEqual([]);

      // A sign-in spends the loop guard, so the next visit may start again straight away.
      expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
      expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeUndefined();
    }
  });

  test('shows a neutral "Signing you in" state, not the sign-in page, while Workeasy360 takes over', async ({ page }) => {
    await registerAndSignIn(page, 'neutral');
    await answerMethods(page, SSO_ONLY);
    await page.context().clearCookies({ name: REFRESH_COOKIE });

    // Answer the start route with 204 No Content: the browser does not leave the page that asked
    // for it, so the state the person sees while Workeasy360 takes over stays on screen.
    const starts: string[] = [];
    await page.route(START, (route) => {
      starts.push(route.request().url());
      return route.fulfill({ status: 204 });
    });

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      starts.length = 0;
      await page.context().clearCookies({ name: GUARD_COOKIE });
      await page.goto('/settings/profile');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Signing you in with Workeasy360…');
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      expect(starts).toHaveLength(1);
      expect(page.url()).toContain('/settings/profile');
      await expect(page.getByLabel('Email address')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toHaveCount(0);

      // Good contrast: foreground text against what is behind it, in both colour schemes.
      const colors = await page.evaluate(() => {
        const main = document.querySelector('main#main')!;
        const heading = main.querySelector('h1')!;
        const note = main.querySelector('p')!;
        return {
          background: getComputedStyle(main).backgroundColor,
          heading: getComputedStyle(heading).color,
          note: getComputedStyle(note).color,
        };
      });
      expect(contrast(parseColor(colors.heading), parseColor(colors.background))).toBeGreaterThanOrEqual(7);
      expect(contrast(parseColor(colors.note), parseColor(colors.background))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('after about five seconds the screen offers a way out: the same start link and the sign-in page', async ({ page }) => {
    await registerAndSignIn(page, 'slow');
    await answerMethods(page, SSO_ONLY);
    await page.context().clearCookies({ name: REFRESH_COOKIE });
    const starts: string[] = [];
    await page.route(START, (route) => {
      starts.push(route.request().url());
      return route.fulfill({ status: 204 });
    });

    await page.goto('/settings/profile');
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Signing you in with Workeasy360…');
    // At first there is nothing to choose.
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to the sign-in page' })).toHaveCount(0);

    // The live region is the status text, not <main> (aria-busy would hide it from a screen reader).
    await expect(page.locator('main#main')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.getByRole('status')).toContainText('You will come straight back to this page.');

    // The spinner stands still for people who ask for less motion.
    const spinner = page.locator('main#main svg').first();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await spinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await spinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');

    // After about five seconds the way out appears, in the same live region.
    const continueLink = page.getByRole('link', { name: 'Continue with Workeasy360' });
    const signInLink = page.getByRole('link', { name: 'Go to the sign-in page' });
    await expect(continueLink).toBeVisible({ timeout: 12_000 });
    await expect(signInLink).toBeVisible();
    await expect(page.getByRole('status')).toContainText('This is taking longer than expected.');
    await expect(heading).toHaveCount(1);
    await expect(page.getByRole('heading')).toHaveCount(1);

    // Continue is the very start URL the automatic start used; the other goes to the sign-in page.
    expect(starts).toHaveLength(1);
    expect(await continueLink.getAttribute('href')).toBe(starts[0]);
    expect(await signInLink.getAttribute('href')).toBe('/login?next=%2Fsettings%2Fprofile');

    // The sign-in page is a choice, not a redirect: following the link starts nothing more.
    await signInLink.click();
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile$/);
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
    await page.waitForTimeout(600);
    expect(starts).toHaveLength(1);
  });

  test('is not done when the deployment also has password sign-in: the sign-in page, as before', async ({ page }) => {
    const starts = await recordStarts(page);
    const urls = trackNavigations(page);

    // The real API here offers the password form only; then an explicit "both ways in".
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await expect(page.getByLabel('Email address')).toBeVisible();

    await answerMethods(page, BOTH);
    await page.context().clearCookies();
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile$/);
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();

    await page.waitForTimeout(800);
    expect(starts).toEqual([]);
    expect(urls.some((url) => url.includes('/api/auth/'))).toBe(false);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
  });

  test('is not done when /auth/methods cannot be read (the sign-in page offers the choice)', async ({ page }) => {
    const starts = await recordStarts(page);
    await page.route('**/auth/methods', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });
});

test.describe('the sign-in page itself never starts anything', () => {
  test('/login, with or without a query, including after a refusal', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    const urls = trackNavigations(page);

    for (const path of ['/login', '/login?sso_error=expired', '/login?sso_error=cancelled&next=%2Ftickets', '/login?signin=workeasy360']) {
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
      await page.waitForTimeout(700);
      expect(page.url()).toContain('/login');
    }
    // The link is still a link: nothing was followed.
    expect(starts).toEqual([]);
    expect(urls.some((url) => url.includes('/api/auth/'))).toBe(false);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
  });

  test('and the other sign-in pages and the access-ended screen do not either', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    for (const path of ['/register', '/forgot-password', '/access-ended?reason=ended']) {
      await page.goto(path);
      await page.waitForTimeout(600);
      expect(new URL(page.url()).pathname).toBe(path.split('?')[0]);
    }
    expect(starts).toEqual([]);
  });
});

test.describe('after signing out of the Help Desk', () => {
  test('"Sign out" leaves a session cookie, and visiting again shows the sign-in page', async ({ page }) => {
    const { email } = await registerAndSignIn(page, 'signout');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.reload();

    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

    const marker = await cookieNamed(page, SIGNED_OUT_COOKIE);
    expect(marker, 'the signed-out marker').toBeTruthy();
    expect(marker!.expires, 'a session cookie: no expiry').toBe(-1);
    expect(marker!.httpOnly).toBe(false);

    for (const visit of ['/', '/dashboard', '/settings/profile']) {
      await page.goto(visit);
      await expect(page).toHaveURL(/\/login(\?next=.*)?$/);
      await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
      await page.waitForTimeout(400);
    }
    expect(starts).toEqual([]);

    // A new tab of the same browser sees the same marker.
    const other = await page.context().newPage();
    await answerMethods(other, SSO_ONLY);
    await other.goto('/tickets');
    await expect(other).toHaveURL(/\/login(\?next=.*)?$/);
    await other.close();
    expect(starts).toEqual([]);

    // A successful sign-in clears the marker; the next visit with no session starts again.
    await answerMethods(page, BOTH);
    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible();
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeUndefined();

    await page.unroute('**/auth/methods');
    await answerMethods(page, SSO_ONLY);
    await page.context().clearCookies({ name: REFRESH_COOKIE });
    await page.goto('/dashboard');
    await expect.poll(() => starts.length).toBe(1);
  });

  test('"Sign out of Easy Help Desk and Workeasy360" leaves the same marker', async ({ page }) => {
    await registerAndSignIn(page, 'signout2');
    await answerMethods(page, SSO_ONLY);
    let leftFor: string | null = null;
    await page.route('**/api/auth/workeasy360/logout', (route) => {
      leftFor = route.request().url();
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'workeasy360 sign-out' });
    });
    const starts = await recordStarts(page);
    await page.reload();

    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out of Easy Help Desk and Workeasy360' }).click();
    await expect.poll(() => leftFor).toContain('/api/auth/workeasy360/logout');

    const marker = await cookieNamed(page, SIGNED_OUT_COOKIE);
    expect(marker, 'the signed-out marker').toBeTruthy();
    expect(marker!.expires).toBe(-1);

    // Workeasy360 sends the person back to the sign-in page; a later visit shows it too.
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Continue with Workeasy360' })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login(\?next=.*)?$/);
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/login(\?next=.*)?$/);
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });

  test('signing out from the access-ended screen leaves it too', async ({ page }) => {
    await registerAndSignIn(page, 'signout3');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.goto('/access-ended?reason=ended');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login(\?next=.*)?$/);
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });

  test('the marker is written BEFORE the sign-out request, so another tab can never start a sign-in in the gap', async ({ page }) => {
    await registerAndSignIn(page, 'gap');
    await answerMethods(page, SSO_ONLY);
    const starts: string[] = [];
    await page.context().route(START, (route) => {
      starts.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Workeasy360</h1>' });
    });
    await page.reload();

    // Hold the sign-out request on its way to the API.
    let markerWhenSent: string | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/auth/logout', async (route) => {
      markerWhenSent = (await cookieNamed(page, SIGNED_OUT_COOKIE))?.value;
      await held;
      await route.continue();
    });
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect.poll(() => markerWhenSent).toBe('1');

    // Meanwhile another tab asks for a session that the server has just ended (401): with the
    // marker already there it shows the sign-in page, and starts nothing.
    const other = await page.context().newPage();
    await answerMethods(other, SSO_ONLY);
    await other.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false,"error":{"code":"TOKEN_EXPIRED","message":"x"}}' }),
    );
    await other.goto('/dashboard');
    await expect(other).toHaveURL(/\/login\?next=%2Fdashboard$/, { timeout: 15_000 });
    await other.waitForTimeout(500);
    expect(starts).toEqual([]);
    await other.close();

    release();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();
    expect(starts).toEqual([]);
  });

  test('a 401 from the sign-out request means there is no session left: signed out, marker kept, nothing starts', async ({ page }) => {
    await registerAndSignIn(page, 'out401');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.route('**/api/v1/auth/logout', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false,"error":{"code":"TOKEN_EXPIRED","message":"x"}}' }),
    );
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();

    await page.context().clearCookies({ name: REFRESH_COOKIE });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });

  test('a network failure or a 5xx keeps the marker (the session may be gone) and says the sign-out failed', async ({ page }) => {
    await registerAndSignIn(page, 'outfail');
    await answerMethods(page, SSO_ONLY);
    await page.route('**/api/v1/auth/logout', (route) => route.abort());
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByText('Could not sign you out')).toBeVisible();
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.unroute('**/api/v1/auth/logout');
    await page.route('**/api/v1/auth/logout', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false,"error":{"code":"UNAVAILABLE","message":"x"}}' }),
    );
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByText('Could not sign you out').first()).toBeVisible();
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a clear refusal (a 4xx other than 401) takes the marker back: the person is still signed in', async ({ page }) => {
    await registerAndSignIn(page, 'out403');
    await answerMethods(page, SSO_ONLY);
    await page.route('**/api/v1/auth/logout', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: '{"success":false,"error":{"code":"FORBIDDEN","message":"x"}}' }),
    );
    await openAccountMenu(page);
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByText('Could not sign you out')).toBeVisible();
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeUndefined();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a refresh that succeeds does not clear the marker: only a real sign-in does', async ({ page }) => {
    await registerAndSignIn(page, 'keep');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);

    // Another tab has begun signing out: its marker stands while this tab's session is still alive.
    await page.context().addCookies([{ name: SIGNED_OUT_COOKIE, value: '1', url: appOrigin() }]);
    await page.reload();
    await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible();
    expect(await cookieNamed(page, SIGNED_OUT_COOKIE)).toBeTruthy();

    // So once the session is gone, the sign-in page is shown, not a silent sign-in.
    await page.context().clearCookies({ name: REFRESH_COOKIE });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });
});

test.describe('the loop guard', () => {
  test('a second automatic start less than 60 seconds later shows the sign-in page', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    // Workeasy360 "completes" but no session comes of it (a dropped cookie): back to the app.
    const starts = await recordStarts(page, (route) =>
      route.fulfill({ status: 302, headers: { location: new URL('/dashboard', appOrigin()).toString() } }),
    );

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/, { timeout: 30_000 });
    expect(starts).toHaveLength(1);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeTruthy();

    // Still within the minute: more visits show the sign-in page and start nothing.
    await page.goto('/settings/profile');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile$/);
    await page.waitForTimeout(500);
    expect(starts).toHaveLength(1);

    // Once the minute has passed (the guard cookie expires), the next visit starts again.
    await page.context().clearCookies({ name: GUARD_COOKIE });
    await page.goto('/dashboard');
    await expect.poll(() => starts.length).toBe(2);
  });
});

test.describe('a session that exists keeps its explanation', () => {
  test('access ended: the access-ended screen, never a new sign-in', async ({ page }) => {
    await registerAndSignIn(page, 'ended');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.route('**/api/v1/auth/me', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'WORKEASY360_ACCESS_ENDED', message: 'ended', details: { reason: 'expired' } },
        }),
      }),
    );

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/access-ended\?reason=ended&detail=expired$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Your access to Easy Help Desk has ended' })).toBeVisible();
    await page.waitForTimeout(800);
    expect(starts).toEqual([]);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
  });

  test('a password-era session (sign-in required): the sign-in page with its explanation, never a new sign-in', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'WORKEASY360_SIGN_IN_REQUIRED', message: 'sign in' } }),
      }),
    );

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?signin=workeasy360$/, { timeout: 30_000 });
    await expect(page.getByText('now signs in with Workeasy360')).toBeVisible();
    await page.waitForTimeout(800);
    expect(starts).toEqual([]);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
  });

  test('a refresh that could not be answered is not "no session": the sign-in page, never a new sign-in', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false,"error":{"code":"UNAVAILABLE","message":"x"}}' }),
    );
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/, { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(starts).toEqual([]);
  });
});

test.describe('API calls and customer pages are not redirected', () => {
  test('a session lost while the app is open ends at the sign-in page; no API call starts a sign-in', async ({ page }) => {
    await registerAndSignIn(page, 'midway');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    const apiNavigations: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.url().includes('/api/')) apiNavigations.push(request.url());
    });

    await page.route('**/api/v1/auth/refresh', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false,"error":{"code":"TOKEN_EXPIRED","message":"x"}}' }),
    );
    await page.route('**/api/v1/tickets**', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"success":false,"error":{"code":"UNAUTHENTICATED","message":"x"}}' }),
    );
    await page.getByRole('link', { name: 'Tickets', exact: true }).first().click();
    await expect(page).toHaveURL(/\/login\?next=%2Ftickets/, { timeout: 15_000 });
    await page.waitForTimeout(600);
    expect(starts).toEqual([]);
    expect(apiNavigations).toEqual([]);
  });

  test('customer help center pages start nothing and keep their own sign-in', async ({ page }) => {
    const { slug } = await registerAndSignIn(page, 'portal');
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);
    await page.context().clearCookies();
    const urls = trackNavigations(page);

    for (const path of [`/help/${slug}`, `/help/${slug}/login`, `/help/${slug}/tickets`, `/help/${slug}/submit`]) {
      await page.goto(path);
      await page.waitForTimeout(900);
      expect(new URL(page.url()).pathname.startsWith(`/help/${slug}`)).toBe(true);
    }
    expect(starts).toEqual([]);
    expect(urls.some((url) => url.includes('/api/auth/'))).toBe(false);
    expect(await cookieNamed(page, GUARD_COOKIE)).toBeUndefined();
  });
});

test.describe('next is a validated same-site path', () => {
  test('a hostile query or encoded path is never forwarded as an off-site address', async ({ page }) => {
    await answerMethods(page, SSO_ONLY);
    const starts = await recordStarts(page);

    await page.goto('/tickets/%2F%2Fevil.example?next=//evil.example&return=https://evil.example');
    await expect.poll(() => starts.length).toBe(1);
    const next = new URL(starts[0]!).searchParams.get('next');
    // Whatever was forwarded is a same-site path: one leading slash, resolving on this origin.
    if (next !== null) {
      expect(next.startsWith('/')).toBe(true);
      expect(next.startsWith('//')).toBe(false);
      expect(new URL(next, 'http://same-site.invalid').origin).toBe('http://same-site.invalid');
    }
    expect(starts[0]).not.toMatch(/https?:\/\/evil/);
  });
});
