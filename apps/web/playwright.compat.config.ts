import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Not part of CI: runs this build next to a real earlier build (AYVO_COMPAT_OLD_ROOT, a worktree of
 * the release returned to, already built) on the isolated e2e database. See e2e-compat/.
 */
export default defineConfig({
  ...base,
  timeout: 300_000,
  projects: [
    {
      name: 'setup',
      testDir: './e2e',
      testMatch: /(auth\.setup|workflow-finance-issuer\.spec)\.ts/,
    },
    {
      name: 'compat',
      testDir: './e2e-compat',
      dependencies: ['setup'],
      use: { storageState: 'e2e/.auth/admin.json' },
    },
  ],
});
