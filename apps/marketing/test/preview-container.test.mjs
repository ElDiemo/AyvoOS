// Review MKT69-R1: the browser tests' preview container belongs to one run. A port held by
// someone else makes the start fail, and the cleanup never removes a container it did not
// create (another run's container on that port, or a cidfile pointing elsewhere). Only test
// containers of this file are used. Runs in CI only, or with AYVO_DOCKER_TESTS=1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  freePort,
  newRun,
  OWNER_LABEL,
  removeOwn,
  startCommand,
} from '../e2e/preview-container.mjs';

const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const root = resolve(import.meta.dirname, '..');
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });
const running = (name) =>
  docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() === 'true';

describe(
  'preview container ownership',
  { skip: !WANT_DOCKER && 'needs CI or AYVO_DOCKER_TESTS=1' },
  () => {
    const other = `ayvo-marketing-e2e-other-${randomBytes(4).toString('hex')}`;
    let port;

    before(async () => {
      port = await freePort();
      // "Another run": a container with another owner label holding the port.
      const r = docker([
        'run',
        '-d',
        '--name',
        other,
        '--label',
        `${OWNER_LABEL}=someone-else`,
        '-p',
        `127.0.0.1:${port}:8080`,
        'caddy:2-alpine',
        'caddy',
        'respond',
        '--listen',
        ':8080',
        'other run',
      ]);
      assert.equal(r.status, 0, r.stderr);
    });
    after(() => {
      docker(['rm', '-f', other]);
    });

    it('a busy port makes the start fail; the cleanup leaves the holder running', () => {
      const run = newRun(port);
      const start = spawnSync('sh', ['-c', startCommand(run, root)], { encoding: 'utf8' });
      assert.notEqual(start.status, 0, 'the start must fail on a busy port');
      const result = removeOwn(run);
      assert.ok(['none', 'removed'].includes(result), result); // at most its own created container
      assert.equal(running(other), true);
    });

    it('a cidfile naming another container is refused, not removed', () => {
      const run = newRun(port);
      const id = docker(['inspect', '-f', '{{.Id}}', other]).stdout.trim();
      writeFileSync(run.cidfile, id);
      assert.equal(removeOwn(run), 'not-owned');
      assert.equal(running(other), true);
    });
  },
);
