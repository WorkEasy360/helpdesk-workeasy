import { expect, test } from '@playwright/test';

/**
 * Critical path through the shipped Phase 1 workspace: create an organization,
 * land in the app, create a customer record and see it listed.
 */
const unique = Date.now().toString(36);
const org = {
  name: `Playwright ${unique}`,
  slug: `pw-${unique}`,
  email: `owner-${unique}@example.test`,
  password: 'Str0ngPassword1',
};

test.describe.configure({ mode: 'serial' });

test('registers an organization and reaches the dashboard', async ({ page }) => {
  await page.goto('/register');

  await page.getByLabel('Organization name').fill(org.name);
  await page.getByLabel('Organization address').fill(org.slug);
  await page.getByLabel('First name').fill('Pat');
  await page.getByLabel('Last name').fill('Owner');
  await page.getByLabel('Work email').fill(org.email);
  await page.getByLabel('Password').fill(org.password);
  await page.getByRole('button', { name: 'Create organization' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: /Welcome back, Pat/ })).toBeVisible();
  // Counters come from the API, so a brand-new organization starts at zero.
  await expect(page.getByRole('link', { name: /Contacts/ })).toContainText('0');
});

test('signs in, creates a contact and finds it in the list', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(org.email);
  await page.getByLabel(/^Password/).fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole('link', { name: 'Customers' }).click();
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.getByText('No contacts yet')).toBeVisible();

  await page.getByRole('button', { name: 'New contact' }).first().click();
  await page.getByLabel('First name').fill('Jamie');
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Email').fill(`jamie-${unique}@example.test`);
  await page.getByRole('button', { name: 'Create contact' }).click();

  await expect(page.getByRole('link', { name: 'Jamie Rivera' })).toBeVisible();

  await page.getByRole('link', { name: 'Jamie Rivera' }).click();
  await expect(page.getByRole('heading', { name: 'Jamie Rivera' })).toBeVisible();
  await expect(page.getByText(`jamie-${unique}@example.test`)).toBeVisible();
});

test('sends an unauthenticated visitor to the login page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/customers');
  // The page asked for is carried along so sign-in can return to it.
  await expect(page).toHaveURL(/\/login(\?next=.*)?$/);
});
