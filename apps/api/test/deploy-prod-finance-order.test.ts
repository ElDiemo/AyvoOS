import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The order of an upgrade and a return (doc 040 §12a, review LANG96-R2): the real branches and
 * functions of scripts/deploy-prod.sh, against a stub of Docker. Steps with outside effects are stubs
 * that record their name. No container is started.
 */
const script = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/deploy-prod.sh'),
  'utf8',
).split('\n');
const tmp = mkdtempSync(join(tmpdir(), 'ayvo-finance-order-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fn = (name: string) => {
  const from = script.findIndex((l) => l.startsWith(`${name}() {`));
  expect(from, name).toBeGreaterThan(-1);
  return script.slice(from, script.indexOf('}', from) + 1).join('\n');
};
const branch = (name: string) => {
  const from = script.indexOf(`  ${name})`);
  expect(from, name).toBeGreaterThan(-1);
  return script.slice(from, script.indexOf('    ;;', from) + 1).join('\n');
};

const OLD = 'a'.repeat(12);
const NEW = 'b'.repeat(12);
const NEW_FULL = 'b'.repeat(40);
const IMAGE = `sha256:${'1'.repeat(64)}`;
const MIGRATE = `sha256:${'2'.repeat(64)}`;

/** Runs one mode's real branch with the API container on `apiImage`. Returns the recorded steps. */
function run(mode: string, opts: { previous: string; finance: string; apiImage?: string }) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  const steps = join(dir, 'steps');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'prod/state/images'), { recursive: true });
  mkdirSync(join(dir, 'prod/releases', OLD), { recursive: true });
  writeFileSync(join(dir, 'prod/releases', OLD, '.ayvo-release'), 'a'.repeat(40));
  writeFileSync(
    join(dir, 'prod/state/images', opts.previous),
    `api ${IMAGE}\napi-migrate ${MIGRATE}\n`,
  );
  writeFileSync(join(dir, 'prod/state/finance.log'), `${OLD} ${IMAGE} ${MIGRATE} 2026-11-01\n`);
  const docker = join(dir, 'bin/docker');
  writeFileSync(
    docker,
    `#!/bin/sh\nif [ "$1" = inspect ]; then echo "${opts.apiImage ?? IMAGE}"; fi\nexit 0\n`,
  );
  chmodSync(docker, 0o755);
  const stubs = [
    'check_release',
    'check_resources',
    'export_release',
    'check_qr_dns',
    'id_dns_info',
    'validate_compose',
    'check_core_holds_finance_contract',
    'backup_status',
    'build_images',
    'wait_healthy',
    'backup_before_migration',
    'migrate',
    'migrate_finance',
    'start_finance',
    'verify_finance',
    'verify',
    'record_finance',
    'record_release',
    'remove_old_images',
  ].map((s) => `${s}() { echo "${s} $*" >>"$STEPS"; }`);
  const body = [
    'set -uo pipefail',
    `STEPS=${steps}; PROD_DIR=${dir}/prod; PROJECT=ayvo-prod; IMAGE_PREFIX=ayvo-prod`,
    `MODE=${mode}; RELEASE=${mode.includes('rollback') ? '' : NEW_FULL}`,
    `ROLLBACK=${OLD}; FINANCE_ROLLBACK=${OLD}; FINANCE_ENABLED=true`,
    `PREVIOUS=${opts.previous}; FINANCE_RELEASE=${opts.finance}`,
    'die() { echo "DIED: $*"; exit 1; }; ok() { echo "ok: $*"; }; log() { :; }; warn() { echo "WARN: $*"; }',
    'compose() { echo "compose $*" >>"$STEPS"; }',
    'release_dir() { printf "%s/releases/%s" "$PROD_DIR" "${1:0:12}"; }',
    ...stubs,
    fn('start_services'),
    fn('pin_finance_images'),
    fn('os_ahead_note'),
    `case $MODE in`,
    branch(mode),
    'esac',
  ].join('\n');
  const res = spawnSync('bash', ['-c', body], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  let recorded: string[] = [];
  try {
    recorded = readFileSync(steps, 'utf8').trim().split('\n');
  } catch {
    // nothing was reached
  }
  return { status: res.status, out: res.stdout + res.stderr, steps: recorded };
}

describe('the order of the OS and Finance (doc 040 §12a)', () => {
  it('Finance first is refused before anything changes: the OS still runs the old release', () => {
    const r = run('finance', { previous: OLD, finance: OLD });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Finance is installed only from the release the OS runs');
    expect(r.steps.filter((s) => !s.startsWith('check_release'))).toEqual([]);
  });

  it('the OS deployment leaves the running Finance alone and names the open window', () => {
    const r = run('deploy', { previous: OLD, finance: OLD });
    expect(r.status).toBe(0);
    expect(r.steps.join('\n')).toContain('compose up -d --no-build api web');
    expect(r.steps.join('\n')).not.toMatch(/finance/);
    expect(r.out).toContain(`Finance still runs ${OLD}`);
    expect(r.out).toContain(`--finance --release ${NEW_FULL}`);
  });

  it('then Finance: pinned to the running API image, backup and migration before the new container', () => {
    const r = run('finance', { previous: NEW, finance: OLD });
    expect(r.status).toBe(0);
    const names = r.steps.map((s) => s.split(' ')[0]);
    const order = ['backup_before_migration', 'migrate_finance', 'start_finance', 'verify_finance'];
    expect(order.map((s) => names.indexOf(s))).toEqual(
      order.map((s) => names.indexOf(s)).sort((a, b) => a - b),
    );
    expect(r.steps).toContain(`backup_before_migration finance finance-${NEW}`);
    expect(r.steps.join('\n')).not.toContain('api web');
  });

  it('the release check is not weakened: an API on another image stops Finance', () => {
    const r = run('finance', {
      previous: NEW,
      finance: OLD,
      apiImage: `sha256:${'9'.repeat(64)}`,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('the API does not run the image');
    expect(r.steps.join('\n')).not.toContain('migrate_finance');
  });

  it('return: the OS goes back first without a migration and names the Finance step', () => {
    const r = run('rollback', { previous: NEW, finance: NEW });
    expect(r.out).not.toContain('DIED');
    expect(r.steps.join('\n')).not.toMatch(/migrate|finance/);
    expect(r.out).toContain(`--finance-rollback ${OLD}`);
  });

  it('then Finance returns to its recorded image, also without a migration', () => {
    const r = run('finance-rollback', { previous: OLD, finance: NEW });
    expect(r.status).toBe(0);
    expect(r.steps.map((s) => s.split(' ')[0])).toEqual([
      'validate_compose',
      'check_core_holds_finance_contract',
      'start_finance',
      'verify_finance',
      'record_finance',
    ]);
    expect(r.out).not.toContain('newer web than Finance');
  });

  it('Finance returned alone under a newer OS says the part stays closed', () => {
    expect(run('finance-rollback', { previous: NEW, finance: NEW }).out).toContain(
      'newer web than Finance',
    );
  });
});
