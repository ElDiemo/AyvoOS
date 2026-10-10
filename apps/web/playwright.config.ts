import { defineConfig, devices } from '@playwright/test';

// Dedicated ports, so a running `pnpm dev` (3000/4000, dev database) is never reused by tests.
const WEB_PORT = 3100;
const API_PORT = 4100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, acceptDownloads: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Built API on a fresh `ayvo_e2e` database (recreated and migrated on every run).
      command: 'node ../api/scripts/start-e2e-server.mjs',
      url: `http://localhost:${API_PORT}/api/health`,
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_PUBLIC_QR_BASE_URL: `http://localhost:${WEB_PORT}/q`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `next start --port ${WEB_PORT}`,
      port: WEB_PORT,
      env: { API_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
