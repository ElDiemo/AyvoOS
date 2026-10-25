// Playwright's stop signal does not reliably reach `docker run`: remove the preview container
// this run started (by its fixed name), whatever happened to the tests.
import { spawnSync } from 'node:child_process';

export default function teardown() {
  spawnSync('docker', ['rm', '-f', 'ayvo-marketing-e2e'], { stdio: 'ignore' });
}
