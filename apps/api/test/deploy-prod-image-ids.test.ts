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
 * then a revision already built is never built again, api/web are always recreated, and they must
 * run exactly the tagged and recorded IDs. The real functions of scripts/deploy-prod.sh run here
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
};

function run(state: State, call: string) {
  const dir = mkdtempSync(join(tmp, 'run-'));
  for (const sub of ['tags', 'ctr', 'prod/state/images'])
    mkdirSync(join(dir, sub), { recursive: true });
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
    `D=${dir}; PROD_DIR=$D/prod; AYVO_RELEASE=${REL}; IMAGE_PREFIX=ayvo-prod; PROJECT=ayvo-prod; STEP=`,
    'log() { :; }; ok() { echo "OK $*"; }; die() { echo "DIE $*"; exit 1; }; wait_healthy() { :; }',
    // docker image inspect --format '{{.Id}}' ayvo-prod/<image>:<rel>  |  docker inspect --format '{{.Image}}' ayvo-prod-<svc>-1
    'docker() {',
    '  local last=${!#}',
    '  if [[ $1 == image ]]; then local n=${last#ayvo-prod/}; n=${n%%:*}; [[ ${last##*:} == "$AYVO_RELEASE" && -f $D/tags/$n ]] || return 1; cat "$D/tags/$n"; echo',
    '  else local s=${last#ayvo-prod-}; s=${s%-1}; [[ -f $D/ctr/$s ]] || return 1; cat "$D/ctr/$s"; echo; fi',
    '}',
    'compose() {',
    '  case $1 in',
    '    build) local n=$2; [[ $n == migrate ]] && n=api-migrate; echo "BUILD $2"; printf "sha256:%064x" $((RANDOM * 32768 + RANDOM)) >"$D/tags/$n" ;;',
    `    up) local force=false s; for s in "$@"; do [[ $s == --force-recreate ]] && force=true; done`,
    `        ${state.composeKeeps ? 'force=false' : ':'}`,
    '        for s in "$@"; do case $s in api|web) if $force || [[ ! -f $D/ctr/$s ]]; then cp "$D/tags/$s" "$D/ctr/$s"; fi ;; esac; done ;;',
    '  esac',
    '}',
    fn('reuse_recorded_images'),
    fn('record_built_images'),
    fn('build_images'),
    fn('check_running_images'),
    fn('start_services'),
    call,
    'echo "TAGS $(cat $D/tags/api) $(cat $D/tags/web)"',
    'echo "CTRS $(cat $D/ctr/api 2>/dev/null) $(cat $D/ctr/web 2>/dev/null)"',
  ].join('\n');
  const file = join(dir, 'run.sh');
  writeFileSync(file, body);
  const out = spawnSync('bash', [file], { encoding: 'utf8' });
  return { status: out.status, out: out.stdout + out.stderr };
}

const BUILT = { api: id('a'), 'api-migrate': id('b'), web: id('c') };

describe('deploy-prod: a release is built once and runs exactly its recorded image IDs', () => {
  it('a second --release of the same revision reuses the recorded images (no build, tags unmoved)', () => {
    const r = run({ tags: { ...BUILT }, containers: {}, recorded: BUILT }, 'build_images');
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('BUILD');
    expect(r.out).toContain('reused as recorded');
    expect(r.out).toContain(`TAGS ${BUILT.api} ${BUILT.web}`);
  });

  it('a tag that no longer names its recorded ID is a stop, never rebuilt over', () => {
    const r = run(
      { tags: { ...BUILT, web: id('d') }, containers: {}, recorded: BUILT },
      'build_images',
    );
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/DIE ayvo-prod\/web:9dd2cf84c474 names .* not the recorded/);
    expect(r.out).not.toContain('BUILD');
  });

  it('only some tags left is a stop; none left (an old release removed) or no record builds', () => {
    const someTags = { api: BUILT.api, 'api-migrate': BUILT['api-migrate'] };
    const partial = run({ tags: someTags, containers: {}, recorded: BUILT }, 'build_images');
    expect(partial.status).toBe(1);
    expect(partial.out).toContain('only some images');
    for (const state of [
      { tags: {}, containers: {}, recorded: BUILT },
      { tags: {}, containers: {} },
    ]) {
      const r = run(state, 'build_images; cat $PROD_DIR/state/images/$AYVO_RELEASE');
      expect(r.status, r.out).toBe(0);
      expect(r.out.match(/BUILD (api|migrate|web)/g)).toHaveLength(3);
      expect(r.out).toMatch(/^api sha256:[0-9a-f]{64}$/m);
    }
  });

  it('start_services recreates api/web onto the tagged IDs although the old containers run (PROD state)', () => {
    // The PROD state: tags = record, but api/web still run an older ID of the same content.
    const r = run(
      { tags: { ...BUILT }, containers: { api: id('e'), web: id('f') }, recorded: BUILT },
      'start_services',
    );
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('api and web run the image IDs of 9dd2cf84c474');
    expect(r.out).toContain(`CTRS ${BUILT.api} ${BUILT.web}`);
  });

  it('a container left on another ID (Compose kept it) fails the deployment', () => {
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

  it('a tag moved away from the record fails even when the container follows the tag', () => {
    const r = run(
      { tags: { ...BUILT, api: id('9') }, containers: {}, recorded: BUILT },
      'start_services',
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('not the image 9dd2cf84c474 was built as');
  });

  it('the script recreates api/web and checks the IDs after every start (deploy and rollback)', () => {
    const start = fn('start_services');
    expect(start).toMatch(/compose up -d --no-build --force-recreate api web/);
    expect(start.indexOf('check_running_images')).toBeGreaterThan(
      start.indexOf('wait_healthy web'),
    );
    expect(fn('build_images').indexOf('reuse_recorded_images')).toBeGreaterThan(-1);
  });
});
