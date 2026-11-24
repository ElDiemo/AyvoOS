import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Image IDs of a production release (PROD 2026-11-16): a second `--release` of the same revision
 * rebuilt its images, every build moved the tag <release> to a new image ID (a fresh attestation
 * index even on a full cache hit), the containerd image store forgot the previous ID while
 * api/web/Finance still ran it, and Compose kept those containers (same platform manifest). Since
 * then the images are checked before anything changes (--check, --release, --rollback), a revision
 * already built is never built again, tags without a record stop, api/web are always recreated, and
 * they must run exactly the tagged and recorded IDs. The real functions of scripts/deploy-prod.sh run here
 * against a fake docker/compose whose tags and containers live in files (reproduced with real
 * Docker 29 + Compose 5 on DEV, see the PR).
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

const branch = (name: string) => {
  const from = script.indexOf(`  ${name})`);
  expect(from, name).toBeGreaterThan(-1);
  return script.slice(from, script.indexOf('    ;;', from) + 1).join('\n');
};

const tmp = mkdtempSync(join(tmpdir(), 'ayvo-image-ids-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REL = '9dd2cf84c474';
const id = (c: string) => `sha256:${c.repeat(64)}`;
type State = {
  tags: Record<string, string>; // image name (api, api-migrate, web) -> ID
  containers: Record<string, string>; // service (api, web) -> ID
  recorded?: Record<string, string>; // state/images/<release>
  /** The fake compose ignores --force-recreate (Compose's own "same manifest → keep"). */
  composeKeeps?: boolean;
  /** The build of this compose service fails (an interrupted build). */
  failBuild?: string;
  /** Docker fails: 'all' = the daemon is down, 'inspect' = only image inspect fails. */
  dockerFails?: 'all' | 'inspect';
};
/** Steps with outside effects: recorded, never real. */
const STUBS = [
  'check_release',
  'check_resources',
  'export_release',
  'check_qr_dns',
  'id_dns_info',
  'validate_compose',
  'backup_status',
  'hold_unverified_portal',
  'verify',
  'record_release',
  'os_ahead_note',
  'backup_before_migration',
  'migrate',
  'remove_old_images',
  // The first-write guard and its --check report: deploy-prod-first-write-guard.test.ts.
  'rollback_first_write_guard',
  'first_write_report',
];

function run(state: State, call: string) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  for (const sub of ['tags', 'ctr', 'prod/state/images', `prod/releases/${REL}`])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'prod/releases', REL, '.ayvo-release'), 'f'.repeat(40));
  for (const [k, v] of Object.entries(state.tags)) writeFileSync(join(dir, 'tags', k), v);
  for (const [k, v] of Object.entries(state.containers)) writeFileSync(join(dir, 'ctr', k), v);
  if (state.recorded)
    writeFileSync(
      join(dir, 'prod/state/images', REL),
      Object.entries(state.recorded)
        .map(([k, v]) => `${k} ${v}\n`)
        .join(''),
    );
  const body = [
    'set -Eeuo pipefail',
    `D=${dir}; PROD_DIR=$D/prod; IMAGE_PREFIX=ayvo-prod; PROJECT=ayvo-prod; STEP=; IMAGES_ACTION=`,
    `AYVO_RELEASE=${REL}; ROLLBACK=${REL}; RELEASE=${REL}${'0'.repeat(28)}; PREVIOUS=${'e'.repeat(12)}; PORTAL_FAILED=`,
    'log() { :; }; warn() { :; }; ok() { echo "OK $*"; }; die() { echo "DIE $*"; exit 1; }; wait_healthy() { :; }',
    'release_dir() { printf "%s/releases/%s" "$PROD_DIR" "${1:0:12}"; }',
    ...STUBS.map((s) => `${s}() { echo "STEP ${s}"; }`),
    // docker image inspect --format '{{.Id}}' ayvo-prod/<image>:<rel>  |  docker inspect --format '{{.Image}}' ayvo-prod-<svc>-1
    'docker() {',
    '  local last=${!#}',
    `  [[ "${state.dockerFails ?? ''}" != all ]] || { echo "Cannot connect to the Docker daemon" >&2; return 1; }`,
    // docker image ls --format … --filter reference=ayvo-prod/*:<rel>: the exact tags of that release
    `  if [[ $1 == image && $2 == ls ]]; then local f; for f in "$D"/tags/*; do [[ -f $f && \${last##*:} == ${REL} ]] && echo "ayvo-prod/\${f##*/}:${REL}"; done; return 0; fi`,
    `  if [[ $1 == image ]]; then [[ "${state.dockerFails ?? ''}" != inspect ]] || { echo "daemon error" >&2; return 1; }; local n=\${last#ayvo-prod/}; n=\${n%%:*}; [[ \${last##*:} == ${REL} && -f $D/tags/$n ]] || return 1; cat "$D/tags/$n"; echo`,
    '  else local s=${last#ayvo-prod-}; s=${s%-1}; [[ -f $D/ctr/$s ]] || return 1; cat "$D/ctr/$s"; echo; fi',
    '}',
    'compose() {',
    '  case $1 in',
    `    build) local n=$2; [[ $n == migrate ]] && n=api-migrate; echo "BUILD $2"; [[ $2 != "${state.failBuild ?? ''}" ]] || return 1; printf "sha256:%064x" $((RANDOM * 32768 + RANDOM)) >"$D/tags/$n" ;;`,
    `    up) echo "UP $*"; local force=false s; for s in "$@"; do [[ $s == --force-recreate ]] && force=true; done`,
    `        ${state.composeKeeps ? 'force=false' : ':'}`,
    '        for s in "$@"; do case $s in api|web) if $force || [[ ! -f $D/ctr/$s ]]; then cp "$D/tags/$s" "$D/ctr/$s"; fi ;; esac; done ;;',
    '  esac',
    '}',
    // The state at the end, also after a stop (die exits).
    'trap \'echo "TAGS $(cat $D/tags/api 2>/dev/null) $(cat $D/tags/web 2>/dev/null)"; echo "CTRS $(cat $D/ctr/api 2>/dev/null) $(cat $D/ctr/web 2>/dev/null)"; echo "RECORD $(tr "\\n" " " <$D/prod/state/images/$AYVO_RELEASE 2>/dev/null)"\' EXIT',
    fn('preflight_images'),
    fn('preflight_rollback_images'),
    fn('record_built_images'),
    fn('build_images'),
    fn('check_running_images'),
    fn('start_services'),
    call,
  ].join('\n');
  const file = join(dir, 'run.sh');
  writeFileSync(file, body);
  const out = spawnSync('bash', [file], { encoding: 'utf8' });
  return { status: out.status, out: out.stdout + out.stderr, dir };
}
const mode = (name: string) => `case ${name} in\n${branch(name)}\nesac`;
const release = 'preflight_images; build_images';

const BUILT = { api: id('a'), 'api-migrate': id('b'), web: id('c') };

describe('deploy-prod: images checked before any change, built once, run as recorded', () => {
  it('a second --release of the same revision reuses the recorded images (no build, tags unmoved)', () => {
    const r = run({ tags: { ...BUILT }, containers: {}, recorded: BUILT }, release);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('BUILD');
    expect(r.out).toContain('reused as recorded');
    expect(r.out).toContain(`TAGS ${BUILT.api} ${BUILT.web}`);
  });

  it('a moved tag or only some tags is a stop, never rebuilt over', () => {
    const moved = run(
      { tags: { ...BUILT, web: id('d') }, containers: {}, recorded: BUILT },
      release,
    );
    expect(moved.status).toBe(1);
    expect(moved.out).toMatch(/DIE ayvo-prod\/web:9dd2cf84c474 names .* not the recorded/);
    const some = { api: BUILT.api, 'api-migrate': BUILT['api-migrate'] };
    const partial = run({ tags: some, containers: {}, recorded: BUILT }, release);
    expect(partial.status).toBe(1);
    expect(partial.out).toContain('only some images');
    for (const r of [moved, partial]) expect(r.out).not.toContain('BUILD');
  });

  it('tags without a record (interrupted build, missing evidence) stop without a build', () => {
    for (const tags of [{ api: BUILT.api }, { ...BUILT }]) {
      const r = run({ tags, containers: {} }, release);
      expect(r.status).toBe(1);
      expect(r.out).toContain('exist without a record in state/images');
      expect(r.out).not.toContain('BUILD');
      expect(r.out).toContain(`TAGS ${tags.api}`);
    }
  });

  it('a clean first build builds and records; a record of removed images is replaced', () => {
    for (const recorded of [undefined, BUILT]) {
      const r = run({ tags: {}, containers: {}, recorded }, release);
      expect(r.status, r.out).toBe(0);
      expect(r.out.match(/BUILD (api|migrate|web)/g)).toHaveLength(3);
      expect(r.out).toMatch(/RECORD api sha256:[0-9a-f]{64} api-migrate sha256:[0-9a-f]{64} web /);
      expect(r.out).not.toContain(`RECORD api ${BUILT.api}`);
    }
  });

  it('an interrupted build leaves no record, the next run stops; the documented removal recovers', () => {
    for (const recorded of [undefined, BUILT]) {
      const broken = run({ tags: {}, containers: {}, recorded, failBuild: 'migrate' }, release);
      expect(broken.status).toBe(1);
      expect(broken.out).toContain('RECORD \n');
      // What the interrupted build left: the api tag, no record.
      const api = /TAGS (sha256:[0-9a-f]{64})/.exec(broken.out)![1]!;
      const next = run({ tags: { api }, containers: {} }, release);
      expect(next.status).toBe(1);
      expect(next.out).toContain('exist without a record');
      expect(next.out).not.toContain('BUILD');
      // doc 036 §7: no container uses it → remove the tag → --check says "build" → --release.
      const recovered = run({ tags: {}, containers: {} }, `${mode('check')}\n${release}`);
      expect(recovered.status, recovered.out).toBe(0);
      expect(recovered.out).toContain('images: build');
      expect(recovered.out.match(/BUILD (api|migrate|web)/g)).toHaveLength(3);
    }
  });

  it('--check runs the same preflight: no "ready" with a moved tag or tags without a record', () => {
    for (const state of [
      { tags: { ...BUILT, api: id('9') }, containers: {}, recorded: BUILT },
      { tags: { web: BUILT.web }, containers: {} },
    ]) {
      const r = run(state, mode('check'));
      expect(r.status).toBe(1);
      expect(r.out).not.toContain('ready to deploy');
      expect(r.out).not.toContain('STEP backup_status');
    }
    const fine = run({ tags: { ...BUILT }, containers: {}, recorded: BUILT }, mode('check'));
    expect(fine.status, fine.out).toBe(0);
    expect(fine.out).toContain('images: reuse');
    expect(fine.out).not.toContain('BUILD');
  });

  it('--release checks the images before validation, the backup and the build', () => {
    const deploy = branch('deploy');
    const at = (s: string) => deploy.indexOf(s);
    expect(at('preflight_images')).toBeGreaterThan(-1);
    for (const later of ['validate_compose', 'backup_status', 'build_images', 'migrate'])
      expect(at('preflight_images'), later).toBeLessThan(at(later));
  });

  it('--rollback with a moved tag or without a record stops before the portal hold and any start', () => {
    for (const state of [
      {
        tags: { ...BUILT, web: id('d') },
        containers: { api: id('e'), web: id('f') },
        recorded: BUILT,
      },
      { tags: { ...BUILT }, containers: { api: id('e'), web: id('f') } },
    ]) {
      const r = run(state, mode('rollback'));
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/DIE .*(not the recorded|no image IDs are recorded)/);
      expect(r.out).not.toContain('STEP hold_unverified_portal');
      expect(r.out).not.toContain('UP ');
      expect(r.out).toContain(`CTRS ${id('e')} ${id('f')}`);
    }
  });

  it('--rollback with the recorded tags recreates api/web onto the recorded IDs', () => {
    const r = run(
      { tags: { ...BUILT }, containers: { api: id('e'), web: id('f') }, recorded: BUILT },
      mode('rollback'),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out.indexOf('images of 9dd2cf84c474 are tagged as recorded')).toBeLessThan(
      r.out.indexOf('STEP hold_unverified_portal'),
    );
    expect(r.out).toContain('UP up -d --no-build --force-recreate api web');
    expect(r.out).toContain('api and web run the image IDs of 9dd2cf84c474');
    expect(r.out).toContain(`CTRS ${BUILT.api} ${BUILT.web}`);
  });

  it('a Docker error is never "no images": --check and --release stop, the record and the images stay', () => {
    for (const dockerFails of ['all', 'inspect'] as const) {
      for (const call of [mode('check'), mode('deploy')]) {
        const r = run({ tags: { ...BUILT }, containers: {}, recorded: BUILT, dockerFails }, call);
        expect(r.status, r.out).toBe(1);
        expect(r.out).toMatch(
          /DIE cannot (list|inspect) .*9dd2cf84c474.*state\/images and the images stay untouched/,
        );
        expect(r.out).not.toContain('BUILD');
        expect(r.out).not.toContain('ready to deploy');
        for (const step of [
          'validate_compose',
          'backup_status',
          'backup_before_migration',
          'migrate',
        ])
          expect(r.out).not.toContain(`STEP ${step}`);
        expect(r.out).toContain(
          `RECORD api ${BUILT.api} api-migrate ${BUILT['api-migrate']} web ${BUILT.web}`,
        );
        expect(r.out).toContain(`TAGS ${BUILT.api} ${BUILT.web}`);
      }
    }
  });

  it('a Docker error in --rollback stops before the portal hold and any start', () => {
    for (const dockerFails of ['all', 'inspect'] as const) {
      const r = run(
        { tags: { ...BUILT }, containers: {}, recorded: BUILT, dockerFails },
        mode('rollback'),
      );
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/DIE cannot (list|inspect) .*stop before any change/);
      expect(r.out).not.toContain('STEP hold_unverified_portal');
      expect(r.out).not.toContain('UP ');
    }
  });

  it('a real --release reuses the recorded images and builds nothing', () => {
    const r = run(
      { tags: { ...BUILT }, containers: { api: id('e'), web: id('f') }, recorded: BUILT },
      mode('deploy'),
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('BUILD');
    expect(r.out).toContain('reused as recorded');
    expect(r.out).toContain(`CTRS ${BUILT.api} ${BUILT.web}`);
  });

  it('start_services recreates api/web onto the tagged IDs although the old containers run (PROD state)', () => {
    const r = run(
      { tags: { ...BUILT }, containers: { api: id('e'), web: id('f') }, recorded: BUILT },
      'start_services',
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('api and web run the image IDs of 9dd2cf84c474');
    expect(r.out).toContain(`CTRS ${BUILT.api} ${BUILT.web}`);
  });

  it('a container left on another ID (Compose kept it) fails after the start', () => {
    const r = run(
      {
        tags: { ...BUILT },
        containers: { api: id('e'), web: BUILT.web },
        recorded: BUILT,
        composeKeeps: true,
      },
      'start_services',
    );
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/DIE api runs sha256:e+, not ayvo-prod\/api:9dd2cf84c474/);
  });

  it('a tag moved away from the record fails after the start even when the container follows it', () => {
    const r = run(
      { tags: { ...BUILT, api: id('9') }, containers: {}, recorded: BUILT },
      'start_services',
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('not the image 9dd2cf84c474 was built as');
  });
});
