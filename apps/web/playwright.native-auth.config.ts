import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './native-e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  // No screenshots, traces or videos: the pages show an MFA seed and recovery codes.
  use: {
    baseURL: 'http://localhost:3210',
    ...devices['Desktop Chrome'],
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: [
    {
      command: 'node ../api/scripts/start-native-auth-e2e.mjs',
      url: 'http://localhost:4210/api/health',
      // SIGTERM (not Playwright's default SIGKILL) lets the runner drop its own test database.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: 'next start --port 3210',
      port: 3210,
      env: { API_URL: 'http://localhost:4210' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
