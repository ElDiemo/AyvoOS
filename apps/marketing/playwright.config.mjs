import { defineConfig, devices } from '@playwright/test';

// The real image (Dockerfile + Caddyfile + site/), published on loopback only, as a DEV preview
// would run it (not indexed). Nothing else is started: the site needs nothing else.
const PORT = 3300;
const IMAGE = 'ayvo-marketing-e2e:local';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  globalTeardown: './e2e/teardown.mjs',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      `docker build -q -t ${IMAGE} . >/dev/null && exec docker run --rm --name ayvo-marketing-e2e ` +
      `-p 127.0.0.1:${PORT}:8080 --read-only --tmpfs /tmp:size=8m,mode=1777 --cap-drop ALL ` +
      `--security-opt no-new-privileges --memory 64m --cpus 0.25 ` +
      `-e 'AYVO_MARKETING_ROBOTS=noindex, nofollow' ${IMAGE}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
