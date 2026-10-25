import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Dedicated ports, so a running `pnpm dev` (3000/4000, dev database) is never reused by tests.
const WEB_PORT = 3100;
/** Session of the e2e operator (all operational roles, MAIN warehouse) — see e2e/auth.setup.ts. */
export const OPERATOR_STATE = 'e2e/.auth/operator.json';
const API_PORT = 4100;
/** The Finance unit (ADR 0039), started by the same e2e server script next to the API. */
const FINANCE_PORT = 4110;
/**
 * Pointer file to the e2e API's file storage: the API creates a fresh temporary directory per run
 * and writes its path here (apps/api/scripts/e2e-storage.mjs); crates.spec.ts reads it to make the
 * storage read-only for a moment. Nothing is ever deleted.
 */
export const E2E_FILE_STORAGE_POINTER = resolve(
  import.meta.dirname,
  'e2e/.storage.e2e-storage-dir',
);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 120_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, acceptDownloads: true },
  projects: [
    // Signs in through the fake identity provider (APP_ENV=test) and stores the sessions.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: OPERATOR_STATE },
    },
  ],
  webServer: [
    {
      // Built API on a fresh `ayvo_e2e` database (recreated and migrated on every run).
      command: 'node ../api/scripts/start-e2e-server.mjs',
      url: `http://localhost:${API_PORT}/api/health`,
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_FINANCE_PORT: String(FINANCE_PORT),
        E2E_PUBLIC_QR_BASE_URL: `http://localhost:${WEB_PORT}/q`,
        E2E_FILE_STORAGE_POINTER,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `next start --port ${WEB_PORT}`,
      port: WEB_PORT,
      env: {
        API_URL: `http://localhost:${API_PORT}`,
        FINANCE_API_URL: `http://localhost:${FINANCE_PORT}`,
      },
      reuseExistingServer: false,
    },
  ],
});
