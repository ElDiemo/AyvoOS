import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/verify-dev-acme.sh (ADR 0026) — found on its first real run: the lego image's binary is
 * /lego, so the state must not be mounted there, and lego needs an account e-mail. `docker` is a
 * stub that records its arguments; Let's Encrypt is never contacted. Fictional fixtures only.
 */
const script = resolve(import.meta.dirname, '../../../scripts/verify-dev-acme.sh');
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayvo-acme-'));
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash\necho "$*" >>"${join(dir, 'calls')}"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (envFile: string) => {
  writeFileSync(join(dir, 'calls'), '');
  const r = spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AYVO_DEV_ENV_FILE: envFile },
    encoding: 'utf8',
  });
  return { ...r, calls: readFileSync(join(dir, 'calls'), 'utf8') };
};

describe('verify-dev-acme.sh', () => {
  it('mounts the state at /state in a throwaway volume, passes the account e-mail, removes the volume', () => {
    const env = join(dir, 'ok.env');
    writeFileSync(env, "DEV_DOMAIN=dev.ayvo.co\nACME_EMAIL='ops@ayvo.test'\n");
    const r = run(env);
    expect(r.status, r.stderr).toBe(0);
    const lego = r.calls.split('\n').find((l) => l.startsWith('run '))!;
    expect(lego).toMatch(/-v ayvo-acme-staging-\d+:\/state /);
    expect(lego).not.toMatch(/:\/lego\b/);
    expect(lego).toContain('--path /state');
    expect(lego).toContain('--email ops@ayvo.test');
    expect(lego).toContain('acme-staging-v02.api.letsencrypt.org');
    expect(r.calls).toMatch(/volume rm -f ayvo-acme-staging-\d+/);
    expect(`${r.stdout}${r.stderr}`).not.toContain('ops@ayvo.test');
  });

  it('refuses without ACME_EMAIL and contacts nothing', () => {
    const env = join(dir, 'none.env');
    writeFileSync(env, 'DEV_DOMAIN=dev.ayvo.co\n');
    const r = run(env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ACME_EMAIL missing');
    expect(r.calls).not.toMatch(/^run /m);
  });
});
