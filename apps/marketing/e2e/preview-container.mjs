// The browser tests' preview container — owned by exactly one test run. Its name, image tag and
// owner label carry a random run id; `docker run --cidfile` records the container this run
// created; cleanup removes only that container, and only if its label says it is this run's.
// A busy host port or name makes the start fail — it never removes whoever holds it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNER_LABEL = 'ayvo.marketing-e2e.run';

/** A free loopback port right now (the start fails cleanly if someone takes it meanwhile). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function newRun(port) {
  const id = randomBytes(6).toString('hex');
  return {
    id,
    port,
    name: `ayvo-marketing-e2e-${id}`,
    image: `ayvo-marketing-e2e:${id}`,
    cidfile: join(mkdtempSync(join(tmpdir(), 'ayvo-marketing-e2e-')), 'container.id'),
  };
}

/** Builds the image and runs it in the foreground (Playwright's webServer command). */
export function startCommand(run, context) {
  return (
    `docker build -q -t ${run.image} ${context} >/dev/null && ` +
    `exec docker run --rm --cidfile ${run.cidfile} --label ${OWNER_LABEL}=${run.id} ` +
    `--name ${run.name} -p 127.0.0.1:${run.port}:8080 --read-only ` +
    `--tmpfs /tmp:size=8m,mode=1777 --cap-drop ALL --security-opt no-new-privileges ` +
    `--memory 64m --cpus 0.25 -e 'AYVO_MARKETING_ROBOTS=noindex, nofollow' ${run.image}`
  );
}

/**
 * Removes what this run created: its container (from its cidfile, only with its own label) and
 * its image tag. Returns what happened, for the regression test.
 */
export function removeOwn(run) {
  let container = 'none';
  if (existsSync(run.cidfile)) {
    const cid = readFileSync(run.cidfile, 'utf8').trim();
    const inspect = spawnSync(
      'docker',
      ['inspect', '-f', `{{index .Config.Labels "${OWNER_LABEL}"}}`, cid],
      { encoding: 'utf8' },
    );
    if (inspect.status === 0) {
      if (inspect.stdout.trim() === run.id) {
        spawnSync('docker', ['rm', '-f', cid], { stdio: 'ignore' });
        container = 'removed';
      } else container = 'not-owned';
    }
  }
  spawnSync('docker', ['image', 'rm', run.image], { stdio: 'ignore' });
  return container;
}
