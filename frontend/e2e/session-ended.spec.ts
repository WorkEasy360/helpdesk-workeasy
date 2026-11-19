import { expect, request as playwright, test, type Cookie, type Page, type WebSocket } from '@playwright/test';

/**
 * A session that ended on the server while a tab still holds its access token. A back-channel
 * logout from Workeasy360 ends a session exactly as a sign-out does: it revokes the session's
 * refresh-token family, and from then on the API refuses every request carrying an access token
 * of that session with 401 SESSION_ENDED (the API suites prove that, logout tokens included:
 * backend/api/test/session-revocation.e2e-spec.ts). These tests prove what the open tab does about
 * it, against the real API: it moves to signed-out at its next refused request, or at once when
 * the realtime channel says the session ended; a reload does not bring the session back; and
 * nothing loops.
 *
 * The session is ended from outside the browser - its own refresh cookie presented to the sign-out
 * route by another HTTP client - so the tab is left exactly as a back-channel logout leaves it: the
 * page still on screen, the access token in memory and the (now revoked) refresh cookie in the jar.
 */

const API = (process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1').replace(/\/+$/, '');
const REFRESH_COOKIE = 'ds_refresh';
const unique = Date.now().toString(36);
let counter = 0;

async function registerAndSignIn(page: Page, label: string): Promise<void> {
  counter += 1;
  const slug = `se-${label}-${unique}${counter}`;
  await page.goto('/register');
  await page.getByLabel('Organization name').fill(`Ended ${label} ${unique}${counter}`);
  await page.getByLabel('Organization address').fill(slug);
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Last name').fill('Owner');
  await page.getByLabel('Work email').fill(`${slug}@example.test`);
  await page.getByLabel('Password').fill('Str0ngPassword1');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(accountMenu(page)).toBeVisible();
}

const accountMenu = (page: Page) => page.getByRole('button', { name: /Account menu for/ });

/** The Authorization header of the page's latest API request: the access token it holds in memory. */
function trackBearer(page: Page): () => string {
  let latest = '';
  page.on('request', (request) => {
    const header = request.headers()['authorization'];
    if (request.url().startsWith(API) && header?.startsWith('Bearer ')) latest = header;
  });
  return () => {
    expect(latest, 'the page sent an access token').not.toBe('');
    return latest;
  };
}

/** Every request the page sends to the given API path. */
function requestsTo(page: Page, path: string): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${API}${path}`)) seen.push(request.url());
  });
  return seen;
}

async function sessionCookie(page: Page): Promise<Cookie> {
  const cookie = (await page.context().cookies()).find((candidate) => candidate.name === REFRESH_COOKIE);
  expect(cookie, 'the agent session cookie').toBeTruthy();
  return cookie!;
}

/** Ends the session on the server without touching the browser: its cookie, from another client. */
async function endSessionElsewhere(cookie: Cookie): Promise<void> {
  const other = await playwright.newContext();
  const response = await other.post(`${API}/auth/logout`, {
    headers: { Cookie: `${cookie.name}=${cookie.value}` },
  });
  expect(response.status()).toBe(200);
  await other.dispose();
}

/** What the API says to a request carrying this access token. */
async function meWith(bearer: string): Promise<{ status: number; code?: string }> {
  const client = await playwright.newContext();
  const response = await client.get(`${API}/auth/me`, { headers: { Authorization: bearer } });
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
  await client.dispose();
  return { status: response.status(), code: body.error?.code };
}

test.describe('a session ended on the server while the tab is open', () => {
  test('the next refused request moves the tab to signed-out, once, and a reload does not restore it', async ({ page }) => {
    // The HTTP path alone: this tab gets no realtime channel, so only a refused request can tell it.
    await page.routeWebSocket(/\/socket\.io\//, (socket) => socket.close());
    const bearer = trackBearer(page);
    await registerAndSignIn(page, 'http');
    const token = bearer();
    expect(await meWith(token)).toEqual({ status: 200, code: undefined });

    const cookie = await sessionCookie(page);
    await endSessionElsewhere(cookie);

    // The very token the tab holds is refused now, though it has not expired.
    expect(await meWith(token)).toEqual({ status: 401, code: 'SESSION_ENDED' });
    // The page that was already rendered stays visible until something asks the API.
    await expect(accountMenu(page)).toBeVisible();
    expect((await sessionCookie(page)).value).toBe(cookie.value);

    const refreshes = requestsTo(page, '/auth/refresh');
    const ticketReads = requestsTo(page, '/tickets');
    await page.getByRole('link', { name: 'Tickets' }).click();

    // Its first refused requests: a renewal (one per request at most, shared while in flight),
    // refused too, and the tab is signed out.
    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
    await expect(accountMenu(page)).toHaveCount(0);
    expect(ticketReads.length).toBeGreaterThan(0);
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    expect(refreshes.length).toBeLessThanOrEqual(4);

    // No loop: nothing more is asked while the sign-in page is up.
    const settled = refreshes.length;
    const readsSettled = ticketReads.length;
    await page.waitForTimeout(3000);
    expect(refreshes.length).toBe(settled);
    expect(ticketReads.length).toBe(readsSettled);
    await expect(page).toHaveURL(/\/login(\?|$)/);

    // A reload (the browser still holds the ended session's cookie) does not bring the session back.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
    await expect(accountMenu(page)).toHaveCount(0);
    expect(refreshes.length - settled).toBeGreaterThanOrEqual(1);
    expect(refreshes.length - settled).toBeLessThanOrEqual(2);
  });

  test('the realtime channel signs the tab out as soon as the session ends, with no action in the tab', async ({ page }) => {
    const agentSockets: WebSocket[] = [];
    const told: string[] = [];
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/socket.io/')) return;
      agentSockets.push(socket);
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string' && frame.payload.includes('"session.ended"')) told.push(frame.payload);
      });
    });
    await registerAndSignIn(page, 'rt');
    await expect.poll(() => agentSockets.length, { message: 'the realtime channel opened' }).toBeGreaterThan(0);
    // Connected and joined: the server announces the agent once the socket is in its rooms.
    await page.waitForTimeout(1000);

    const refreshes = requestsTo(page, '/auth/refresh');
    await endSessionElsewhere(await sessionCookie(page));

    await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
    await expect(accountMenu(page)).toHaveCount(0);
    expect(told.length).toBeGreaterThanOrEqual(1);
    // A renewal settled it, and nothing more is asked afterwards.
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    expect(refreshes.length).toBeLessThanOrEqual(2);
    const settled = refreshes.length;
    await page.waitForTimeout(3000);
    expect(refreshes.length).toBe(settled);
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test('a session that was not ended is unaffected', async ({ browser }) => {
    const ended = await browser.newPage();
    const kept = await browser.newPage();
    await registerAndSignIn(ended, 'gone');
    await registerAndSignIn(kept, 'kept');
    await endSessionElsewhere(await sessionCookie(ended));
    await expect(ended).toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });

    await kept.getByRole('link', { name: 'Tickets' }).click();
    await expect(kept).toHaveURL(/\/tickets/, { timeout: 15_000 });
    await expect(accountMenu(kept)).toBeVisible();
    await kept.reload();
    await expect(accountMenu(kept)).toBeVisible({ timeout: 15_000 });
    await ended.close();
    await kept.close();
  });
});
