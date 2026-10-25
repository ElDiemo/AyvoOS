import { defineConfig, devices } from '@playwright/test';
import { freePort, newRun, startCommand } from './e2e/preview-container.mjs';

// The real image (Dockerfile + Caddyfile + site/), published on a free loopback port only, as a
// DEV preview would run it (not indexed). Nothing else is started: the site needs nothing else.
// The container belongs to this run alone (e2e/preview-container.mjs); the run is handed to the
// workers and the teardown through the environment.
const run = process.env.AYVO_MARKETING_E2E_RUN
  ? JSON.parse(process.env.AYVO_MARKETING_E2E_RUN)
  : newRun(await freePort());
process.env.AYVO_MARKETING_E2E_RUN = JSON.stringify(run);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${run.port}` },
  globalTeardown: './e2e/teardown.mjs',
  webServer: {
    command: startCommand(run, '.'),
    url: `http://127.0.0.1:${run.port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
