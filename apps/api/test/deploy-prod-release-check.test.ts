import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * check_release's S3 guard (ADR 0032): the real function of scripts/deploy-prod.sh against a real
 * git repository. Under `set -o pipefail` a `git show … | grep -q` failed when grep stopped at the
 * first match and git got SIGPIPE — a valid release was refused as "has no S3 file storage"
 * (PROD GO-2, 2026-11-13). The guard must still refuse a release without S3 or without env.ts.
 */
const script = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/deploy-prod.sh'),
  'utf8',
).split('\n');
const fn = (name: string) => {
  const from = script.findIndex((l) => l.startsWith(`${name}() {`));
  expect(from, name).toBeGreaterThan(-1);
  return script.slice(from, script.indexOf('}', from) + 1).join('\n');
};

const tmp = mkdtempSync(join(tmpdir(), 'ayvo-release-check-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
};

/** A repository whose only commit (on origin/main) has the given env.ts, or none. */
function repo(envTs: string | null): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmp, 'repo-'));
  git(dir, 'init', '-q');
  spawnSync('mkdir', ['-p', join(dir, 'deploy/prod'), join(dir, 'apps/api/src/config')]);
  writeFileSync(join(dir, 'deploy/prod/compose.yml'), 'services: {}\n');
  if (envTs !== null) writeFileSync(join(dir, 'apps/api/src/config/env.ts'), envTs);
  else writeFileSync(join(dir, 'apps/api/src/config/.keep'), '');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'release');
  const commit = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', commit);
  return { dir, commit };
}

function checkRelease(r: { dir: string; commit: string }) {
  const body = [
    'set -Eeuo pipefail',
    `REPO=${r.dir}; RELEASE=${r.commit}`,
    'log() { :; }; check_checkout() { :; }',
    'ok() { echo "OK $*"; }',
    'die() { echo "DIE $*"; exit 1; }',
    // fetch is the network: the test's origin/main ref is already in place.
    'repo_git() { if [[ $1 == fetch ]]; then return 0; fi; git -C "$REPO" "$@"; }',
    fn('check_release'),
    'check_release',
  ].join('\n');
  const file = join(tmp, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, body);
  const out = spawnSync('bash', [file], { encoding: 'utf8' });
  unlinkSync(file);
  return { status: out.status, out: out.stdout + out.stderr };
}

// The match comes first and the rest is far larger than a pipe buffer: an early-exiting grep
// leaves git writing into a closed pipe on every run.
const S3_FIRST = `FILE_STORAGE_DRIVER: z.enum(['local', 's3'])\n${'// filler line\n'.repeat(200_000)}`;

describe('check_release: the S3 file storage guard', () => {
  it('accepts a release with S3 storage, also when env.ts is far larger than a pipe buffer', () => {
    const r = repo(S3_FIRST);
    for (let i = 0; i < 5; i++) {
      const res = checkRelease(r);
      expect(res.out).not.toContain('has no S3 file storage');
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain('is on origin/main');
    }
  });

  it('accepts the real env.ts of this checkout', () => {
    const real = readFileSync(resolve(import.meta.dirname, '../src/config/env.ts'), 'utf8');
    const res = checkRelease(repo(real));
    expect(res.status, res.out).toBe(0);
  });

  it('refuses a release whose env.ts has no S3 storage', () => {
    const res = checkRelease(repo(`FILE_STORAGE_DRIVER: z.enum(['local'])\n`.repeat(10_000)));
    expect(res.status).toBe(1);
    expect(res.out).toContain('has no S3 file storage');
  });

  it('refuses a release without env.ts (fail closed)', () => {
    const res = checkRelease(repo(null));
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/DIE .*env\.ts/);
  });
});
