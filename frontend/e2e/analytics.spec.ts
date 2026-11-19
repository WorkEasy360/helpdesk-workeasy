import { expect, test } from '@playwright/test';

/**
 * Phase 7 through the real UI: an administrator watches a ticket's numbers land on the
 * dashboard and in reports, turns on satisfaction surveys, and exports a CSV.
 */
const unique = Date.now().toString(36);
const org = {
  name: `Reports ${unique}`,
  slug: `reports-${unique}`,
  email: `reports-${unique}@example.test`,
  password: 'Str0ngPassword1',
};

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(org.email);
  await page.getByLabel(/^Password/).fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('a resolved ticket appears on the dashboard', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Organization name').fill(org.name);
  await page.getByLabel('Organization address').fill(org.slug);
  await page.getByLabel('First name').fill('Rae');
  await page.getByLabel('Last name').fill('Reports');
  await page.getByLabel('Work email').fill(org.email);
  await page.getByLabel(/^Password/).fill(org.password);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await page.getByRole('button', { name: 'New contact' }).first().click();
  await page.getByLabel('First name').fill('Nadia');
  await page.getByLabel('Last name').fill('Rahman');
  await page.getByLabel('Email').fill(`nadia-${unique}@example.test`);
  await page.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByRole('link', { name: 'Nadia Rahman' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tickets' }).click();
  await page.getByRole('button', { name: 'New ticket' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New ticket' });
  await dialog.getByLabel('Subject').fill('Checkout fails with a payment error');
  await dialog.getByLabel('Description').fill('Every payment attempt returns an error page.');
  await dialog.getByLabel('Requester').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page).toHaveURL(/\/tickets\/[a-z0-9]+$/);

  await page.getByRole('button', { name: 'Resolve' }).click();
  const resolveDialog = page.getByRole('dialog', { name: 'Resolve ticket' });
  await resolveDialog.getByLabel('Resolution note').fill('Fixed the payment gateway configuration.');
  await resolveDialog.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('Ticket resolved')).toBeVisible();

  await page.goto('/dashboard');
  await expect(
    page.locator('a[href^="/tickets"]').filter({ hasText: 'Created' }).getByText('1', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
});

test('reports show the same ticket across tabs and an export can be downloaded', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/reports$/);

  await expect(page.getByRole('tab', { name: 'Tickets' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Resolved').first()).toBeVisible();

  await page.getByRole('button', { name: 'Save this view' }).click();
  await page.getByPlaceholder('View name').fill('This week');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('option', { name: 'This week' })).toBeAttached();

  await page.getByRole('tab', { name: 'Agents' }).click();
  await expect(page.getByRole('cell', { name: 'Rae Reports' })).toBeVisible();

  await page.getByRole('tab', { name: 'SLA' }).click();
  await expect(page.getByText('Resolution compliance')).toBeVisible();

  await page.getByRole('tab', { name: 'Exports' }).click();
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByText('Export queued')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({ timeout: 15_000 });
});

test('an administrator turns on satisfaction surveys', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Satisfaction surveys' }).click();
  await expect(page).toHaveURL(/\/settings\/csat$/);
  await page.getByLabel('Send a satisfaction survey when a ticket is resolved').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Satisfaction survey settings saved')).toBeVisible();
});
