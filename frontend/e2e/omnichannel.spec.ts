import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Phase 5 through the real UI: an administrator connects an email channel, a signed
 * inbound message becomes a ticket, and a visitor holds a live chat with an agent.
 */
const unique = Date.now().toString(36);
const org = {
  name: `Omni ${unique}`,
  slug: `omni-${unique}`,
  email: `omni-${unique}@example.test`,
  password: 'Str0ngPassword1',
};

test.describe.configure({ mode: 'serial' });

let webhookUrl = '';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(org.email);
  await page.getByLabel(/^Password/).fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('registers an organization and connects an email channel', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Organization name').fill(org.name);
  await page.getByLabel('Organization address').fill(org.slug);
  await page.getByLabel('First name').fill('Omar');
  await page.getByLabel('Last name').fill('Admin');
  await page.getByLabel('Work email').fill(org.email);
  await page.getByLabel(/^Password/).fill(org.password);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/settings/channels');
  // The page header and the empty state each offer one; which exists first depends on timing.
  await page.getByRole('button', { name: 'New channel' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Support inbox');
  await dialog.getByLabel('Support address').fill(`support@${org.slug}.test`);
  await dialog.getByLabel('Shared signing secret').fill('browser-signing-secret');
  await dialog.getByRole('button', { name: 'Save channel' }).click();

  await expect(page.getByText('Channel saved')).toBeVisible();
  await expect(page.getByText('Webhook URL')).toBeVisible();

  webhookUrl = (await page.locator('code').first().textContent()) ?? '';
  expect(webhookUrl).toContain('/webhooks/');
});

test('an inbound email arrives as a ticket', async ({ page, request }) => {
  const payload = JSON.stringify({
    messageId: `<browser-${unique}@mail.test>`,
    from: '"Nadia Rahman" <nadia@example.test>',
    to: `support@${org.slug}.test`,
    subject: 'Invoice PDF will not open',
    text: 'The invoice downloads but will not open.',
  });
  const signature = createHmac('sha256', 'browser-signing-secret').update(payload).digest('hex');

  const response = await request.post(webhookUrl, {
    headers: { 'Content-Type': 'application/json', 'x-digisoft-signature': signature },
    data: payload,
  });
  expect(response.ok()).toBe(true);

  await signIn(page);
  await page.goto('/tickets');
  await expect(page.getByRole('link', { name: /Invoice PDF will not open/ })).toBeVisible();

  await page.goto('/settings/channels');
  await expect(page.getByText('processed').first()).toBeVisible();
});

test('a visitor chats with an agent from the help center', async ({ page, browser }) => {
  await signIn(page);
  await page.goto('/settings/channels');
  await page.getByRole('button', { name: 'New channel' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('CHAT');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Website chat');
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByText('Channel saved')).toBeVisible();

  // The visitor, in their own browser context.
  const visitor = await browser.newContext();
  const widget = await visitor.newPage();
  await widget.goto(`/help/${org.slug}`);
  await widget.getByRole('button', { name: 'Chat with us' }).click();
  await widget.getByLabel('Your name').fill('Nadia Rahman');
  await widget.getByLabel('Email address').fill('nadia@example.test');
  await widget.getByLabel('Your message').fill('Can I change my billing date?');
  await widget.getByRole('button', { name: 'Start chatting' }).click();
  await expect(widget.getByText('Can I change my billing date?')).toBeVisible();

  // The agent picks it up and answers.
  await page.goto('/chat');
  await page.getByRole('button', { name: /Nadia Rahman/ }).click();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Chat accepted — it is assigned to you')).toBeVisible();

  await page.getByLabel('Chat reply').fill('Yes — any date in the first week works.');
  await page.getByRole('button', { name: 'Send' }).click();

  // …and it reaches the visitor's widget over the socket.
  await expect(widget.getByText('Yes — any date in the first week works.')).toBeVisible({
    timeout: 15_000,
  });
  await visitor.close();
});
