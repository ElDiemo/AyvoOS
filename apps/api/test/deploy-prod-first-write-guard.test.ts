import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The first-write guard of `deploy-prod.sh --rollback` (review of main 0d9d056, P1): after the first
 * write of the bottle-cycle chain (R3-b, R1.1) the release before it answers 500 on every receipt
 * with a BOTTLES line (proven in isolation against 32e3d47), so a rollback to it must be refused —
 * fix forward (doc 070 §5). Whether the check is required comes from the migration history, never
 * from the detector file being there; the running release is checked before it is paused, api/web
 * stay stopped while the data is read, and every doubt is a stop that starts the very same
 * containers again. The real functions of scripts/deploy-prod.sh run here against a fake
 * docker/compose (the real SQL against real databases: see the PR).
 */
const root = resolve(import.meta.dirname, '../../..');
const scriptText = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');
const script = scriptText.split('\n');
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
const constant = (name: string) => {
  const line = script.find((l) => l.startsWith(`readonly ${name}=`));
  expect(line, name).toBeDefined();
  return line!;
};

const DETECTOR = 'scripts/sql/bottle-cycle-first-write-detector.sql';
const detectorText = readFileSync(join(root, DETECTOR), 'utf8');
const MIGRATIONS = [
  '20261119090000_bottle_fill_circulations',
  '20261119090100_reuse_placement_enum_values',
  '20261119090200_reuse_placement_filling',
  '20261119090300_returns_r1_1_enum_values',
  '20261119090400_returns_r1_1',
  '20261119090500_returns_r1_issue_freed_crate',
];

const tmp = mkdtempSync(join(tmpdir(), 'ayvo-first-write-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ROLLBACK = '32e3d4783af0';
const RUNNING = '0d9d05644d9b';
const id = (c: string) => `sha256:${c.repeat(64)}`;
const RUNNING_IDS = { api: id('a'), web: id('b') };
const NONE = '0|0|0|0|0|0|0|';
const AFTER = '21|29|13|4|0|0|0|2026-11-23 15:02:11.123+00';

type State = {
  /** Answer of the migration-history query, or a failure. */
  schema?: string | 'fail';
  /** Answer of the detector, or a failure. */
  detector?: string | 'fail';
  /** The detector file of the checkout: as reviewed, missing or changed. */
  detectorFile?: 'reviewed' | 'missing' | 'changed';
  /** The rollback target's export has the chain's migrations. */
  targetHasChain?: boolean;
  /** state/current-release (default: the running release, 40 characters). */
  currentRelease?: string | null;
  /** state/images/<running> (default: the running IDs). */
  recordedRunning?: Record<string, string> | null;
  /** The containers that run (default: the running IDs). */
  containers?: Record<string, string>;
  failStop?: boolean;
  failStart?: boolean;
  unhealthy?: boolean;
  /** compose start brings up another image (it must be the same containers). */
  startsOther?: boolean;
  failConfig?: boolean;
};

const STUBS = [
  'preflight_rollback_images',
  'validate_compose',
  'hold_unverified_portal',
  'start_services',
  'verify',
  'record_release',
  'os_ahead_note',
  'check_release',
  'check_resources',
  'export_release',
  'check_qr_dns',
  'id_dns_info',
  'preflight_images',
  'backup_status',
];

function run(state: State, call: string) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  const prod = join(dir, 'prod');
  for (const sub of ['ctr', 'repo/scripts/sql', 'prod/state/images', `prod/releases/${ROLLBACK}`])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(
    join(prod, 'releases', ROLLBACK, '.ayvo-release'),
    `${ROLLBACK}${'0'.repeat(28)}\n`,
  );
  if (state.targetHasChain)
    for (const m of MIGRATIONS) {
      const d = join(prod, 'releases', ROLLBACK, 'apps/api/prisma/migrations', m);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'migration.sql'), '-- migration\n');
    }
  const file = state.detectorFile ?? 'reviewed';
  if (file !== 'missing')
    writeFileSync(
      join(dir, 'repo', DETECTOR),
      file === 'reviewed' ? detectorText : detectorText.replace('> 0', '> 1'),
    );
  if (state.currentRelease !== null)
    writeFileSync(
      join(prod, 'state/current-release'),
      `${state.currentRelease ?? `${RUNNING}${'1'.repeat(28)}`}\n`,
    );
  const recorded = state.recordedRunning === undefined ? RUNNING_IDS : state.recordedRunning;
  if (recorded)
    writeFileSync(
      join(prod, 'state/images', RUNNING),
      Object.entries({ ...recorded, 'api-migrate': id('e') })
        .map(([k, v]) => `${k} ${v}\n`)
        .join(''),
    );
  for (const [k, v] of Object.entries(state.containers ?? RUNNING_IDS))
    writeFileSync(join(dir, 'ctr', k), v);
  writeFileSync(join(dir, 'schema'), state.schema ?? `6|6|0`);
  writeFileSync(join(dir, 'detector'), state.detector ?? NONE);

  const body = [
    'set -Eeuo pipefail; exec 2>&1', // one stream: the order of the steps is the evidence
    `D=${dir}; PROD_DIR=${prod}; REPO_ROOT=$D/repo; IMAGE_PREFIX=ayvo-prod; PROJECT=ayvo-prod; STEP=`,
    `PREVIOUS=${RUNNING}; ROLLBACK=${ROLLBACK}; RELEASE=${'f'.repeat(40)}; AYVO_RELEASE=; MODE=rollback; PORTAL_FAILED=; GUARD_PAUSED=; IMAGES_ACTION=reuse`,
    constant('FIRST_WRITE_MIGRATIONS'),
    constant('FIRST_WRITE_DETECTOR'),
    constant('FIRST_WRITE_DETECTOR_SHA256'),
    constant('FIRST_WRITE_NONE'),
    'log() { echo "LOG $*"; }; warn() { echo "WARN $*"; }; ok() { echo "OK $*"; }',
    'die() { echo "DIE $*"; exit 1; }',
    `wait_healthy() { [[ "${state.unhealthy ? 'yes' : ''}" != yes ]]; }`,
    'release_dir() { printf "%s/releases/%s" "$PROD_DIR" "${1:0:12}"; }',
    ...STUBS.map((s) => `${s}() { echo "STEP ${s} $AYVO_RELEASE"; }`),
    // docker inspect --format '{{.Image}}' ayvo-prod-<svc>-1: the container's image ID.
    'docker() { local last=${!#} s; s=${last#ayvo-prod-}; s=${s%-1}; [[ -f $D/ctr/$s && ! -f $D/ctr/$s.stopped ]] || return 1; cat "$D/ctr/$s"; echo; }',
    'compose() {',
    '  echo "COMPOSE[$AYVO_RELEASE] $*" >&2',
    '  case $1 in',
    `    config) [[ "${state.failConfig ? 'yes' : ''}" != yes ]] ;;`,
    // stop/start the very containers (no recreation): marked stopped, started again.
    `    stop) [[ "${state.failStop ? 'yes' : ''}" != yes ]] || return 1; touch "$D/ctr/api.stopped" "$D/ctr/web.stopped" ;;`,
    `    start) [[ "${state.failStart ? 'yes' : ''}" != yes ]] || return 1; rm -f "$D"/ctr/*.stopped; ${state.startsOther ? `echo ${id('f')} >"$D/ctr/api"` : ':'} ;;`,
    '    exec) local sql; sql="$(cat)"',
    // Read only: everything runs inside BEGIN READ ONLY … ROLLBACK, errors stop psql.
    `      [[ $sql == "BEGIN READ ONLY;"$'\\n'*$'\\n'"ROLLBACK;" && $* == *ON_ERROR_STOP=1* ]] || { echo "NOT READ ONLY" >&2; return 1; }`,
    '      if [[ $sql == *_prisma_migrations* ]]; then echo "SQL history" >&2; local a; a=$(<"$D/schema")',
    '      else echo "SQL detector" >&2; [[ $sql == *"$(<"$REPO_ROOT/scripts/sql/bottle-cycle-first-write-detector.sql")"* ]] || return 1; local a; a=$(<"$D/detector"); fi',
    '      [[ $a != fail ]] || { echo "ERROR:  column does not exist" >&2; return 3; }; printf "%s\\n" "$a" ;;',
    '  esac',
    '}',
    'trap \'echo "CTRS $(cat $D/ctr/api 2>/dev/null) $(cat $D/ctr/web 2>/dev/null) stopped=$(ls $D/ctr | grep -c stopped)"; echo "CURRENT $(cat $PROD_DIR/state/current-release 2>/dev/null)"\' EXIT',
    fn('read_only_sql'),
    fn('first_write_schema'),
    fn('first_write_detector'),
    fn('rollback_first_write_guard'),
    fn('resume_after_guard'),
    fn('first_write_report'),
    call,
  ].join('\n');
  const path = join(dir, 'run.sh');
  writeFileSync(path, body);
  const out = spawnSync('bash', [path], { encoding: 'utf8' });
  return { status: out.status, out: out.stdout + out.stderr };
}
const mode = (name: string) => `case ${name} in\n${branch(name)}\nesac`;
const rollback = mode('rollback');
const RUNNING_CTRS = `CTRS ${RUNNING_IDS.api} ${RUNNING_IDS.web}`;

/** A stop before the pause: nothing stopped, nothing started, the running release untouched. */
function expectStoppedBeforeAnyChange(r: ReturnType<typeof run>) {
  expect(r.status, r.out).toBe(1);
  expect(r.out).toMatch(/DIE .*stop before any change/);
  expect(r.out).not.toContain(' stop api web');
  expect(r.out).not.toContain('STEP hold_unverified_portal');
  expect(r.out).not.toContain('STEP start_services');
  expect(r.out).toContain(`${RUNNING_CTRS} stopped=0`);
}

/** A stop after the pause: the same containers again, nothing rolled back or recorded. */
function expectResumed(r: ReturnType<typeof run>) {
  expect(r.status, r.out).toBe(1);
  expect(r.out).toContain(`COMPOSE[${RUNNING}] stop api web`);
  expect(r.out).toContain(`COMPOSE[${RUNNING}] start api web`);
  expect(r.out).not.toMatch(/COMPOSE\[.*\] up /);
  expect(r.out).toContain(
    `${RUNNING} runs again unchanged (same containers); nothing was rolled back`,
  );
  for (const s of ['hold_unverified_portal', 'start_services', 'verify', 'record_release'])
    expect(r.out).not.toContain(`STEP ${s}`);
  expect(r.out).toContain(`${RUNNING_CTRS} stopped=0`);
  expect(r.out).toContain(`CURRENT ${RUNNING}`);
}

describe('deploy-prod --rollback: the first-write guard of the bottle-cycle chain', () => {
  it('ships the reviewed detector byte for byte (#207 f3109820, run on DEV) and pins its hash', () => {
    const sha = createHash('sha256').update(detectorText).digest('hex');
    expect(sha).toBe('c246e06698a969b621dc9102490e903a62c8b8b398484b554773adaff5d9d601');
    expect(constant('FIRST_WRITE_DETECTOR_SHA256')).toContain(sha);
    expect(constant('FIRST_WRITE_MIGRATIONS')).toBe(
      `readonly FIRST_WRITE_MIGRATIONS="${MIGRATIONS.join(' ')}"`,
    );
    for (const m of MIGRATIONS)
      expect(() =>
        readFileSync(join(root, 'apps/api/prisma/migrations', m, 'migration.sql')),
      ).not.toThrow();
  });

  it('runs inside the lock, after the image and Compose checks, before the portal hold and any start', () => {
    const rb = branch('rollback');
    const at = (s: string) => rb.indexOf(s);
    expect(at('rollback_first_write_guard')).toBeGreaterThan(-1);
    for (const before of ['preflight_rollback_images', 'validate_compose'])
      expect(at(before), before).toBeLessThan(at('rollback_first_write_guard'));
    for (const after of ['hold_unverified_portal', 'start_services', 'record_release'])
      expect(at('rollback_first_write_guard'), after).toBeLessThan(at(after));
    expect(scriptText.indexOf('flock -n 9 ||')).toBeLessThan(scriptText.indexOf('\ncase $MODE in'));
    expect(scriptText).not.toMatch(/--(force|skip|no)-first-write/);
  });

  it('all zero: api/web of the running release are paused while it reads, then the rollback starts', () => {
    const r = run({}, rollback);
    expect(r.status, r.out).toBe(0);
    const at = (s: string) => r.out.indexOf(s);
    expect(at('SQL history')).toBeLessThan(at(`COMPOSE[${RUNNING}] stop api web`));
    expect(at(`COMPOSE[${RUNNING}] stop api web`)).toBeLessThan(at('SQL detector'));
    expect(at('SQL detector')).toBeLessThan(at(`OK no first write (${NONE})`));
    expect(at(`OK no first write`)).toBeLessThan(at(`STEP hold_unverified_portal ${ROLLBACK}`));
    expect(at(`STEP hold_unverified_portal`)).toBeLessThan(at(`STEP start_services ${ROLLBACK}`));
    expect(r.out).not.toContain(' start api web');
    expect(r.out).not.toContain('NOT READ ONLY');
  });

  it('a first write, an empty, extra or malformed answer, or a SQL error: STOP, the same api/web run again', () => {
    for (const detector of [
      AFTER,
      '0|0|0|1|0|0|0|',
      '0|0|0|0|0|0|1|',
      '0|0|0|0|0|0|0|2026-11-23 15:02:11+00',
      '',
      `${NONE}\n${NONE}`,
      '0|0|0|0|0|0|0',
      ' 0|0|0|0|0|0|0|',
      'fail',
    ]) {
      const r = run({ detector }, rollback);
      expectResumed(r);
      if (detector === 'fail')
        expect(r.out).toContain('the detector failed (SQL error or no database)');
      else expect(r.out).toContain('rollback to 32e3d4783af0 refused — fix forward (doc 070 §5)');
    }
    expect(run({ detector: AFTER }, rollback).out).toContain(`found (${AFTER})`);
  });

  it('chain applied and the detector missing or changed: STOP before anything is paused', () => {
    for (const detectorFile of ['missing', 'changed'] as const) {
      const r = run({ detectorFile }, rollback);
      expectStoppedBeforeAnyChange(r);
      expect(r.out).toContain('is missing or not the reviewed one');
      expect(r.out).not.toContain('SQL detector');
    }
  });

  it('old schema (none of the chain ever ran): the rollback as before, without a pause or a file', () => {
    for (const detectorFile of ['reviewed', 'missing'] as const) {
      const r = run({ schema: '0|0|0', detectorFile }, rollback);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('OK the bottle-cycle migrations never ran here');
      expect(r.out).not.toContain(' stop api web');
      expect(r.out).not.toContain('SQL detector');
      expect(r.out).toContain(`STEP start_services ${ROLLBACK}`);
    }
  });

  it('a target that has the chain reads its data: no limit (e.g. back from a later release to 0d9d056)', () => {
    const r = run({ targetHasChain: true, detector: AFTER, detectorFile: 'missing' }, rollback);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('has the bottle-cycle migrations and reads their data');
    expect(r.out).not.toContain('SQL ');
    expect(r.out).not.toContain(' stop api web');
  });

  it('a partly applied chain or an unreadable history: STOP before any change', () => {
    for (const schema of [
      '3|3|0',
      '5|6|1',
      '6|6|1',
      '0|1|1',
      '0|1|0',
      '6|5|0',
      'fail',
      '',
      'x|y|z',
    ]) {
      const r = run({ schema }, rollback);
      expectStoppedBeforeAnyChange(r);
      expect(r.out).toMatch(
        schema === 'fail' || !/^\d+\|\d+\|\d+$/.test(schema)
          ? /not readable/
          : /chain is partial \(finished\|started\|unfinished: .* of 6\): no verified state for 32e3d4783af0/,
      );
    }
  });

  it('the running release is checked before the pause: state, recorded IDs, containers, Compose', () => {
    for (const [state, msg] of [
      [{ currentRelease: `${'9'.repeat(40)}` }, 'state/current-release is not the running'],
      [{ currentRelease: null }, 'state/current-release is not the running'],
      [{ recordedRunning: null }, 'no image IDs are recorded for the running'],
      [{ recordedRunning: { api: RUNNING_IDS.api, web: id('9') } }, 'web runs'],
      [{ containers: { api: RUNNING_IDS.api } }, 'web runs nothing'],
      [{ failConfig: true }, 'does not validate'],
    ] as const) {
      const r = run(state, rollback);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(msg);
      expect(r.out).toMatch(/stop before any change/);
      expect(r.out).not.toContain(' stop api web');
      expect(r.out).not.toContain('SQL detector');
      expect(r.out).not.toContain('STEP start_services');
    }
  });

  it('api/web did not stop: the same containers start again and it stops', () => {
    const r = run({ failStop: true }, rollback);
    expectResumed(r);
    expect(r.out).toContain('api/web of 0d9d05644d9b did not stop');
    expect(r.out).not.toContain('SQL detector');
  });

  it('a failed restore after a STOP is loud: what failed, nothing rolled back, api/web left as they are', () => {
    for (const [state, msg] of [
      [{ failStart: true }, 'and api/web of 0d9d05644d9b did not start again'],
      [{ unhealthy: true }, 'and api of 0d9d05644d9b did not become healthy again'],
      [{ startsOther: true }, `and api runs ${id('f')}, not the paused ${RUNNING_IDS.api}`],
    ] as const) {
      const r = run({ ...state, detector: AFTER }, rollback);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(`first write of the bottle-cycle chain found (${AFTER})`);
      expect(r.out).toContain(msg);
      expect(r.out).not.toContain('STEP start_services');
      expect(r.out).not.toContain('STEP record_release');
      expect(r.out).toContain(`CURRENT ${RUNNING}`);
    }
  });

  it('an interruption while paused names the stopped api/web and how to start the same ones (on_exit)', () => {
    const exit = fn('on_exit');
    expect(exit).toContain('[[ -n $GUARD_PAUSED ]]');
    expect(exit).toContain('docker start $PROJECT-api-1 $PROJECT-web-1');
    // The pause lasts until the rollback's own start; a stop clears it only after the restore.
    const rb = branch('rollback');
    expect(rb.indexOf('GUARD_PAUSED=""')).toBeGreaterThan(rb.indexOf('hold_unverified_portal'));
    expect(rb.indexOf('GUARD_PAUSED=""')).toBeLessThan(rb.indexOf('start_services'));
    // A failed restore leaves them stopped (named by on_exit); an allowed read keeps the pause.
    expect(run({ failStart: true, detector: AFTER }, rollback).out).toContain('stopped=2');
    const allowed = run({}, 'rollback_first_write_guard; echo "PAUSED=$GUARD_PAUSED"');
    expect(allowed.out).toContain('PAUSED=allowed');
    expect(allowed.out).toContain('stopped=2');
  });

  it('--check reports the state read only, never pauses and never fails on it', () => {
    for (const [state, msg] of [
      [{}, `OK first-write guard: no first write yet (${NONE})`],
      [{ detector: AFTER }, `WARN first-write guard: first write found (${AFTER})`],
      [{ detector: 'fail' }, 'WARN first-write guard: the detector failed'],
      [{ schema: '0|0|0' }, 'OK first-write guard: the bottle-cycle chain is old here'],
      [{ schema: 'fail' }, 'WARN first-write guard: the migration history is not readable now'],
      [{ schema: '3|3|0' }, 'OK first-write guard: the bottle-cycle chain is partial'],
      [{ detectorFile: 'changed' }, 'WARN first-write guard: scripts/sql/'],
    ] as const) {
      const r = run(state, mode('check'));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(msg);
      expect(r.out).not.toContain(' stop api web');
      expect(r.out).not.toContain(' start api web');
      expect(r.out).toContain('ready to deploy');
    }
  });
});
