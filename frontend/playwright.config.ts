import { defineConfig, devices } from '@playwright/test';

/**
 * Drives the real frontend against the real API. Start the API first (see
 * ../backend); Playwright starts this app with `pnpm dev` unless one is already
 * listening on the base URL.
 *
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE when the machine already has a Chromium that
 * Playwright did not download itself (CI images, sandboxes).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:3000/login',
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
});
