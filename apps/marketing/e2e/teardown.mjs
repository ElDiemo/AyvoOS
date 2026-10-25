// Playwright's stop signal does not reliably reach `docker run`: remove the preview container
// this run created — and nothing else (e2e/preview-container.mjs checks the owner label).
import { removeOwn } from './preview-container.mjs';

export default function teardown() {
  const run = process.env.AYVO_MARKETING_E2E_RUN;
  if (run) removeOwn(JSON.parse(run));
}
