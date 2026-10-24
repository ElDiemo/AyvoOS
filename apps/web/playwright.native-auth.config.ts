import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './native-e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  use: { baseURL: 'http://localhost:3210', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'node ../api/scripts/start-native-auth-e2e.mjs',
      url: 'http://localhost:4210/api/health',
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
