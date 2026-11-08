import { defineConfig, devices } from '@playwright/test';

/**
 * portal-web in the browser (ADR 0045 §10, PR 5), against synthetic stand-ins of the core's and
 * Finance's portal contracts (e2e/stub-backends.mjs) — the contracts themselves are tested in the
 * API suite; the walk with the real units is step 7 on DEV. 390 px and 1440 px.
 */
const env = {
  APP_ENV: 'test',
  PORTAL_PUBLIC_ORIGIN: 'http://localhost:3300',
  CORE_INTERNAL_URL: 'http://127.0.0.1:4301',
  FINANCE_INTERNAL_URL: 'http://127.0.0.1:4311',
  PORTAL_CORE_TOKEN: 'c'.repeat(43),
  PORTAL_FINANCE_TOKEN: 'f'.repeat(43),
};

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  // No traces or videos: the pages show an MFA seed and recovery codes (synthetic here).
  use: { baseURL: 'http://localhost:3300', trace: 'off', video: 'off', screenshot: 'off' },
  projects: [
    {
      name: 'mobile-390',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node e2e/stub-backends.mjs',
      url: 'http://127.0.0.1:4301/__state',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'next start --port 3300',
      port: 3300,
      env,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
