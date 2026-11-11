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
  // Two package slots here, so the per-account and the global limit can be told apart.
  PORTAL_PACKAGE_MAX_IN_FLIGHT: '2',
  // Start quotas off here (the other specs download repeatedly); package-quota.spec uses the
  // second server below with the defaults.
  PORTAL_PACKAGE_ACCOUNT_INTERVAL_MINUTES: '0',
  PORTAL_PACKAGE_ACCOUNT_PER_DAY: '1000',
  PORTAL_PACKAGE_GLOBAL_PER_DAY: '10000',
};
/** The second server: the package start quotas as configured by default (10 min, 4/day); the
 * third (3302) has the package switched off. */
const quotaEnv = {
  ...env,
  PORTAL_PUBLIC_ORIGIN: 'http://localhost:3301',
  PORTAL_PACKAGE_ACCOUNT_INTERVAL_MINUTES: '10',
  PORTAL_PACKAGE_ACCOUNT_PER_DAY: '4',
  PORTAL_PACKAGE_GLOBAL_PER_DAY: '30',
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
    {
      command: 'next start --port 3301',
      port: 3301,
      env: quotaEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'next start --port 3302',
      port: 3302,
      env: { ...env, PORTAL_PUBLIC_ORIGIN: 'http://localhost:3302', PORTAL_PACKAGE_ENABLED: '0' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
