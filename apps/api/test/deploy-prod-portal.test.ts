import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The hotel portal steps of scripts/deploy-prod.sh (doc 064 A1, review 5858165597), run as the real
 * functions taken from the script:
 * - P1: a public portal that fails its public check is never left open — it goes back to the image
 *   that was the verified public portal (verified again) or only portal-web is stopped and the
 *   closed route is checked; the OS, QR, ID and marketing are checked again and never restarted.
 *   An OS deployment never opens a portal-web that was not verified as public. Docker, Compose
 *   and curl are test doubles that record every call (no production project is touched); the
 *   public check itself is the real verify_portal_release, made to fail by the edge's answers.
 * - P2: the archive is checked BEFORE `docker load` (real Docker: CI or AYVO_DOCKER_TESTS=1): its
 *   approved SHA-256, exactly one image of the expected ID and exactly one DEV portal-web tag —
 *   an archive carrying the running or a rollback tag, in any of the three places `docker load`
 *   takes names from, is refused and those tags keep their images.
 */
const root = resolve(import.meta.dirname, '../../..');
const script = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const bash = (body: string) =>
  spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { ...process.env } });

/** The source of one function of the script (from `name() {` to its closing brace). */
function fn(name: string): string {
  const i = script.indexOf(`\n${name}() {`);
  expect(i, name).toBeGreaterThan(0);
  return script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}
/** A part of the main flow, between two exact lines (inclusive). */
function between(from: string, to: string, after = 0): string {
  const a = script.indexOf(from, after);
  expect(a, from).toBeGreaterThan(0);
  const b = script.indexOf(to, a);
  expect(b, to).toBeGreaterThan(a);
  return script.slice(a, b + to.length);
}
const HELPERS = [
  'set -Eeuo pipefail',
  'log() { echo "LOG $*"; }',
  'ok() { echo "OK $*"; }',
  'warn() { echo "WARN $*"; }',
  'die() { echo "DIE $*"; exit 1; }',
].join('\n');

const OLD = `sha256:${'a'.repeat(64)}`; // the verified public portal
const NEW = `sha256:${'b'.repeat(64)}`; // the release under test
const PORTAL = 'portal.example.test';

describe('P1: the public portal fails closed (review 5858165597)', () => {
  /**
   * A world of doubles. State in $S: `running` = image of portal-web (absent = no container),
   * `tags` = "<tag> <image>" lines, `calls` = every docker/compose/curl call. The edge answers
   * for the portal host from what runs: nothing → its own 503; an image in `$S/bad-api` → the
   * internal API reachable (the failed public check); else the correct portal.
   */
  function world(opts: {
    running?: string;
    log?: string[];
    badApi?: string[];
    stopFails?: boolean;
    marketingDown?: boolean;
  }) {
    const s = mkdtempSync(join(tmpdir(), 'ayvo-portal-p1-'));
    mkdirSync(join(s, 'prod/state'), { recursive: true });
    if (opts.running) writeFileSync(join(s, 'running'), opts.running);
    writeFileSync(join(s, 'tags'), `ayvo-prod/portal-web:new ${NEW}\n`);
    if (opts.log) writeFileSync(join(s, 'prod/state/portal.log'), `${opts.log.join('\n')}\n`);
    writeFileSync(join(s, 'bad-api'), `${(opts.badApi ?? []).join('\n')}\n`);
    const doubles = `
S=${s}
PROJECT=ayvo-prod; IMAGE_PREFIX=ayvo-prod; PROD_DIR=$S/prod
DOMAIN=os.example.test; QR_DOMAIN=qr.example.test; PORTAL_DOMAIN=${PORTAL}
PROD_PUBLIC_IPV4=192.0.2.10; PROD_TAILNET_IPV4=100.64.0.10
PORTAL_ENABLED=true; PORTAL_PUBLIC=on; PORTAL_RELEASE=new; MARKETING_RELEASE=mk1
PORTAL_OUTCOME=""; PORTAL_FAILED=""; PORTAL_PREVIOUS_IMAGE=""; PORTAL_PREVIOUS_PUBLIC=false
running() { cat "$S/running" 2>/dev/null || true; }
docker() {
  echo "docker $*" >>"$S/calls"
  case $1 in
    inspect) [[ -s $S/running ]] && cat "$S/running" || return 1 ;;
    ps) [[ -s $S/running ]] && echo c0ffee; return 0 ;;
    stop) return 0 ;;
    rm) ${opts.stopFails ? 'return 0' : 'rm -f "$S/running"; return 0'} ;;
    tag) echo "\${3} \${2}" >>"$S/tags"; return 0 ;;
    *) echo "unexpected docker $*" >&2; return 1 ;;
  esac
}
compose() {
  echo "compose $*" >>"$S/calls"
  [[ "$*" == "--profile portal up -d --no-build --no-deps portal-web" ]] || { echo "unexpected compose $*" >&2; return 1; }
  local image
  image="$(awk -v t="ayvo-prod/portal-web:$PORTAL_RELEASE" '$1 == t { i = $2 } END { print i }' "$S/tags")"
  [[ -n $image ]] || return 1
  printf '%s' "$image" >"$S/running"
}
wait_healthy() { [[ -s $S/running ]]; }
verify_portal_private() { [[ -s $S/running ]] && echo "OK private"; }
verify_id_edge() { echo "CHECKED id $1"; }
verify_marketing_release() { echo "CHECKED marketing $1"; ${opts.marketingDown ? 'echo "DIE marketing down"; exit 1' : ':'}; }
verify_marketing_edge() { echo "CHECKED marketing-edge $1"; }
curl() {
  local method=GET url="" hosthdr="" headers=false fmt=""
  while (($#)); do
    case $1 in
      -X) method=$2; shift ;; -H) hosthdr=$2; shift ;; -D) headers=true; shift ;; -w) fmt=$2; shift ;;
      -o | --max-time | --resolve) shift ;;
      http://* | https://*) url=$1 ;;
    esac
    shift
  done
  echo "curl $method $url" >>"$S/calls"
  local host=\${url#*://}; host=\${host%%/*}
  local path="/\${url#*://*/}" code img
  if [[ $host == "$PORTAL_DOMAIN" ]]; then
    img="$(running)"
    if [[ -z $img ]]; then code=503
    elif [[ -n $hosthdr ]]; then code=421
    elif [[ $path == /api* ]]; then grep -qx "$img" "$S/bad-api" && code=200 || return 52
    elif [[ $method != GET ]]; then code=405
    else code=200; fi
    if $headers; then
      printf 'HTTP/2 %s\\r\\n' "$code"
      [[ $code != 200 ]] || printf "content-security-policy: script-src 'nonce-x'\\r\\n"
      return 0
    fi
  elif [[ $host == "$DOMAIN" ]]; then [[ $path == /login ]] && code=200 || code=404
  elif [[ $host == "$QR_DOMAIN" ]]; then code=404
  else return 6; fi
  if [[ $fmt == *redirect_url* ]]; then printf '%s ' "$code"; else printf '%s' "$code"; fi
}
edge_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:$PROD_TAILNET_IPV4" "$@"; }
`;
    const functions = [
      'record_portal',
      'last_portal_record',
      'portal_verified_public',
      'stop_portal_web',
      'verify_portal_closed',
      'verify_other_hosts',
      'close_portal_route',
      'hold_unverified_portal',
      'start_portal',
      'verify_portal_release',
      'verify_portal_edge',
    ]
      .map(fn)
      .join('\n');
    const run = (body: string) => {
      const res = bash(`${HELPERS}\n${doubles}\n${functions}\n${body}`);
      const read = (f: string) => {
        try {
          return readFileSync(join(s, f), 'utf8');
        } catch {
          return '';
        }
      };
      return {
        out: res.stdout + res.stderr,
        status: res.status,
        calls: read('calls').trim().split('\n').filter(Boolean),
        log: read('prod/state/portal.log').trim().split('\n').filter(Boolean),
        running: read('running'),
      };
    };
    return { run, dir: s };
  }
  /** The `--portal` flow from the main case, as in the script (from start_portal on). */
  const portalFlow = between('    start_portal "$image"\n', '    record_portal SUCCESS "$image"\n');
  const asPortal = () => `
image=${NEW}
PORTAL_PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' "$PROJECT-portal-web-1" 2>/dev/null || true)"
if portal_verified_public "$PORTAL_PREVIOUS_IMAGE"; then PORTAL_PREVIOUS_PUBLIC=true; fi
${portalFlow}
echo FLOW-SUCCESS`;
  const verifiedOld = `old 2026-11-10T10:00:00Z SUCCESS image=${OLD} public=on`;
  /** Only portal-web is ever touched: no edge, OS, Finance or marketing container. */
  const onlyPortal = (calls: string[]) => {
    const changes = calls.filter((c) => c.startsWith('docker') || c.startsWith('compose'));
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c, c).toMatch(/portal-web/);
      expect(c, c).not.toMatch(/qr-edge|caddy|dns|finance|marketing|(?<![-\w])(api|web)(?![-\w])/);
    }
  };

  it('a correct release: verified, recorded SUCCESS, nothing closed', () => {
    const w = world({ running: OLD, log: [verifiedOld] });
    const r = w.run(asPortal());
    expect(r.out).toContain('FLOW-SUCCESS');
    expect(r.running).toBe(NEW);
    expect(r.log.at(-1)).toMatch(new RegExp(`SUCCESS image=${NEW} public=on`));
  });

  it('forced failure (internal API reachable), previous image was the verified public portal: restored and verified again', () => {
    const w = world({ running: OLD, log: [verifiedOld], badApi: [NEW] });
    const r = w.run(asPortal());
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('FLOW-SUCCESS');
    expect(r.out).toMatch(/must be aborted/); // the real public check failed
    expect(r.out).toMatch(
      /DIE .*failed the public check: the previous public portal image .* runs again/,
    );
    expect(r.running).toBe(OLD);
    expect(r.log.slice(-2)).toEqual([
      expect.stringMatching(`UNVERIFIED image=${NEW}`),
      expect.stringMatching(`^restore-aaaaaaaaaaaa .* RESTORED image=${OLD} public=on$`),
    ]);
    // The others were checked after the restore.
    expect(r.out).toContain('CHECKED id');
    expect(r.out).toContain('CHECKED marketing');
    expect(r.calls).toContain(`curl GET https://os.example.test/login`);
    expect(r.calls.some((c) => c.startsWith('curl GET https://qr.example.test/'))).toBe(true);
    onlyPortal(r.calls);
  });

  it('forced failure, no verified previous portal: portal-web stopped, the route answers only the edge 503, others checked', () => {
    const w = world({ badApi: [NEW] }); // first public release: nothing ran before
    const r = w.run(asPortal());
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(
      /DIE .*failed the public check: portal-web stopped, the portal route is closed/,
    );
    expect(r.running).toBe('');
    expect(r.log.slice(-2)).toEqual([
      expect.stringMatching(`UNVERIFIED image=${NEW}`),
      expect.stringMatching(/ CLOSED image=none public=on$/),
    ]);
    // The closed route was checked over the public address after the stop.
    const stop = r.calls.indexOf('docker stop ayvo-prod-portal-web-1');
    expect(stop).toBeGreaterThan(0);
    expect(r.calls.slice(stop)).toContain(`curl GET https://${PORTAL}/login`);
    expect(r.out).toContain('CHECKED marketing');
    onlyPortal(r.calls);
  });

  it('forced failure, the previous one was only private (never public): closed, not restored', () => {
    const w = world({
      running: OLD,
      log: [`old 2026-11-10T10:00:00Z SUCCESS image=${OLD} public=off`],
      badApi: [NEW],
    });
    const r = w.run(asPortal());
    expect(r.running).toBe('');
    expect(r.log.at(-1)).toMatch(/ CLOSED image=none/);
    expect(r.calls.join('\n')).not.toContain('restore-');
  });

  it('the restored image fails the check too: closed', () => {
    const w = world({ running: OLD, log: [verifiedOld], badApi: [NEW, OLD] });
    const r = w.run(asPortal());
    expect(r.out).toMatch(/did not verify again: closing the portal route/);
    expect(r.running).toBe('');
    expect(r.log.at(-1)).toMatch(/ CLOSED image=none/);
  });

  it('portal-web cannot be removed (the route still serves): fails loudly, never claims closed', () => {
    const w = world({ badApi: [NEW], stopFails: true });
    const r = w.run(asPortal());
    expect(r.out).toMatch(
      /DIE .*still serves a page after portal-web was stopped: close it by hand/,
    );
    expect(r.log.join('\n')).not.toContain('CLOSED');
  });

  it('closed, but another service fails its check afterwards: the failure is named (the portal stays closed)', () => {
    const w = world({ badApi: [NEW], marketingDown: true });
    const r = w.run(asPortal());
    expect(r.running).toBe('');
    expect(r.log.at(-1)).toMatch(/ CLOSED/);
    expect(r.out).toContain('DIE marketing down');
  });

  it('the new image never becomes healthy (public): the same closing, not a silent restore', () => {
    const w = world({ running: OLD, log: [verifiedOld] });
    // No tag for the new release → Compose cannot start it.
    const r = w.run(`sed -i '/portal-web:new /d' "$S/tags"\n${asPortal()}`);
    expect(r.out).toMatch(
      /DIE the portal release did not start: the previous public portal image .* runs again/,
    );
    expect(r.running).toBe(OLD);
  });

  describe('the OS deployment (PORTAL_PUBLIC=on)', () => {
    it('stops a running portal-web that was never verified as public BEFORE the edge opens its site', () => {
      const w = world({
        running: NEW,
        log: [`new 2026-11-10T10:00:00Z SUCCESS image=${NEW} public=off`],
      });
      const r = w.run('hold_unverified_portal; echo HELD');
      expect(r.out).toContain('HELD');
      expect(r.running).toBe('');
      expect(r.log.at(-1)).toMatch(/ CLOSED image=none/);
    });

    it('keeps the verified public portal, verifies it again behind the new edge', () => {
      const w = world({ running: OLD, log: [verifiedOld] });
      const r =
        w.run(`release_dir() { echo "$S/rel"; }; mkdir -p "$S/rel/deploy/prod"; : >"$S/rel/deploy/prod/compose.portal-edge.yml"
AYVO_RELEASE=x
hold_unverified_portal
eval "$(declare -f curl | sed '1s/curl/public_curl/')"
curl() { case "$*" in *"http://${PORTAL}/login"*) printf '301 https://${PORTAL}/login' ;; *acme-challenge*) printf '404' ;; *) public_curl "$@" ;; esac; }
verify_portal_edge 192.0.2.10
echo "FAILED=[$PORTAL_FAILED]"`);
      expect(r.out).toContain('verified again behind the new edge');
      expect(r.out).toContain('FAILED=[]');
      expect(r.running).toBe(OLD);
      expect(r.calls.join('\n')).not.toContain('docker stop');
    });

    it('a verified portal that fails behind the new edge is closed; the deployment reports it after recording the OS', () => {
      const w = world({ running: OLD, log: [verifiedOld], badApi: [OLD] });
      const r =
        w.run(`release_dir() { echo "$S/rel"; }; mkdir -p "$S/rel/deploy/prod"; : >"$S/rel/deploy/prod/compose.portal-edge.yml"
AYVO_RELEASE=x
eval "$(declare -f curl | sed '1s/curl/public_curl/')"
curl() { case "$*" in *"http://${PORTAL}/login"*) printf '301 https://${PORTAL}/login' ;; *acme-challenge*) printf '404' ;; *) public_curl "$@" ;; esac; }
verify_portal_edge 192.0.2.10
echo "FAILED=$PORTAL_FAILED"`);
      expect(r.out).toMatch(
        /FAILED=the public portal failed its check after the OS deployment: portal-web stopped/,
      );
      expect(r.running).toBe('');
      expect(r.log.at(-1)).toMatch(/ CLOSED image=none/);
      onlyPortal(r.calls);
    });

    it('the main flow: the hold before the edge starts, and a closed portal fails the run after the OS is recorded', () => {
      for (const mode of ['  deploy)\n', '  rollback)\n']) {
        const at = script.indexOf(mode);
        const block = script.slice(at, script.indexOf('\n    ;;\n', at));
        const hold = block.indexOf('hold_unverified_portal');
        expect(hold, mode).toBeGreaterThan(0);
        expect(block.indexOf('start_services')).toBeGreaterThan(hold);
        const failed = block.indexOf('[[ -z $PORTAL_FAILED ]] || die');
        expect(failed).toBeGreaterThan(block.indexOf('record_release'));
      }
    });
  });

  it('the --portal flow closes the route on a failed private OR public check, never records SUCCESS first', () => {
    expect(portalFlow).toMatch(
      /if ! \(verify_portal_private\) \|\| ! \(verify_portal_release "\$PROD_PUBLIC_IPV4"\); then/,
    );
    expect(portalFlow.indexOf('close_portal_route')).toBeLessThan(
      portalFlow.indexOf('record_portal SUCCESS'),
    );
    // The previous image's public state is taken before anything is loaded or recorded.
    const main = between('  portal | portal-rollback)\n', '    start_portal "$image"\n');
    expect(main.indexOf('PORTAL_PREVIOUS_PUBLIC=true')).toBeLessThan(
      main.indexOf('load_portal_image'),
    );
  });
});

describe.skipIf(!WANT_DOCKER)(
  'P2: the archive is checked before docker load (review 5858165597)',
  () => {
    const id = randomBytes(4).toString('hex');
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-portal-p2-'));
    const PREFIX = `ayvo-ptest-${id}`; // stands in for ayvo-prod
    const REPO = `ayvo-ptest-${id}-dev/portal-web`; // stands in for ayvo-dev-preview/portal-web
    const GOOD_TAG = `${REPO}:${'c'.repeat(12)}-20261111T120000Z`;
    const RUNNING_TAG = `${PREFIX}/portal-web:${'d'.repeat(12)}-${'1'.repeat(12)}`;
    const RESTORE_TAG = `${PREFIX}/portal-web:restore-${'2'.repeat(12)}`;
    const revision = 'e'.repeat(40);
    const d = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8' });
    const imageId = (ref: string) =>
      d('image', 'inspect', '--format', '{{.Id}}', ref).stdout.trim();
    const sha = (file: string) =>
      `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
    const images: Record<'running' | 'restore' | 'fresh' | 'evil', string> = {
      running: '',
      restore: '',
      fresh: '',
      evil: '',
    };
    const build = (name: string, tag: string) => {
      const ctx = join(dir, name);
      mkdirSync(ctx, { recursive: true });
      writeFileSync(join(ctx, 'f'), `${name}-${id}\n`);
      writeFileSync(
        join(ctx, 'Dockerfile'),
        `FROM scratch\nCOPY f /f\nLABEL org.opencontainers.image.revision=${revision}\n`,
      );
      expect(d('build', '-q', '-t', tag, ctx).status).toBe(0);
      return imageId(tag);
    };
    const save = (file: string, ...refs: string[]) => {
      expect(d('save', '-o', join(dir, file), ...refs).status).toBe(0);
      chmodSync(join(dir, file), 0o644);
      return join(dir, file);
    };
    /** Rewrites one JSON member of an archive (a tampered archive, approved by its own SHA-256). */
    const tamper = (src: string, out: string, member: string, jq: string) => {
      const x = join(dir, `x-${out}`);
      const res = spawnSync('bash', [
        '-c',
        `set -e; mkdir -p ${x}; tar -xf ${src} -C ${x}; jq -c '${jq}' ${x}/${member} > ${x}/m.tmp; mv ${x}/m.tmp ${x}/${member}; ` +
          `cd ${x}; tar -cf ${join(dir, out)} $(tar -tf ${src} | grep -v '/$' | tr '\\n' ' ')`,
      ]);
      expect(res.status, res.stderr.toString()).toBe(0);
      chmodSync(join(dir, out), 0o644);
      return join(dir, out);
    };
    const prodDir = join(dir, 'prod');
    const load = (file: string, expected: string, digest = sha(file)) =>
      bash(
        `${HELPERS}\nIMAGE_PREFIX=${PREFIX}; PROD_DIR=${prodDir}; PORTAL_ARCHIVE_TAG=""; PORTAL_ARCHIVE_COPY=""\n` +
          `${fn('check_portal_archive').replace('readonly ', '')}\n${fn('load_portal_image')}\n` +
          `PORTAL_ARCHIVE_REPO=${REPO}\n` +
          `load_portal_image ${file} ${expected} ${digest}; echo "LOADED $PORTAL_RELEASE"`,
      );
    /** The running and the rollback tags still name their own images. */
    const untouched = () => {
      expect(imageId(RUNNING_TAG)).toBe(images.running);
      expect(imageId(RESTORE_TAG)).toBe(images.restore);
    };
    let good = '';

    beforeAll(() => {
      images.running = build('running', RUNNING_TAG);
      images.restore = build('restore', RESTORE_TAG);
      images.fresh = build('fresh', GOOD_TAG);
      images.evil = build('evil', `${PREFIX}-evil:x`);
      good = save('good.tar', GOOD_TAG);
      // Remove the good tag again: PROD has never seen it.
      expect(d('image', 'rm', GOOD_TAG).status).toBe(0);
    }, 300_000);

    afterAll(() => {
      spawnSync('bash', [
        '-c',
        `docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ayvo-ptest-${id}' | xargs -r docker image rm -f >/dev/null 2>&1`,
      ]);
    });

    it('the approved archive: exactly its one image, tagged for production', () => {
      const r = load(good, images.fresh);
      expect(r.stdout, r.stdout + r.stderr).toContain(
        `LOADED ${'e'.repeat(12)}-${images.fresh.slice(7, 19)}`,
      );
      expect(imageId(GOOD_TAG)).toBe(images.fresh);
      untouched();
      // The private copy is gone (on a refusal the script's on_exit removes it).
      expect(
        spawnSync('bash', ['-c', `ls ${prodDir}/state | grep -c portal-archive || true`], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).toBe('0');
      expect(script).toMatch(
        /\[\[ -z \$\{PORTAL_ARCHIVE_COPY:-\} \]\] \|\| rm -f -- "\$PORTAL_ARCHIVE_COPY"/,
      );
      d('image', 'rm', GOOD_TAG);
    });

    it('another SHA-256 than the approved one: refused before docker load', () => {
      const r = load(good, images.fresh, `sha256:${'0'.repeat(64)}`);
      expect(r.stdout).toMatch(/DIE the archive is not the approved one/);
      expect(imageId(GOOD_TAG)).toBe('');
    });

    it('a second image carrying the RUNNING tag: refused, the running tag keeps its image', () => {
      // An archive with the good image AND another image under the running production tag.
      expect(d('tag', images.evil, RUNNING_TAG).status).toBe(0);
      expect(d('tag', images.fresh, GOOD_TAG).status).toBe(0);
      const bad = save('two-images.tar', GOOD_TAG, RUNNING_TAG);
      expect(d('tag', images.running, RUNNING_TAG).status).toBe(0);
      d('image', 'rm', GOOD_TAG);
      untouched();
      const r = load(bad, images.fresh);
      expect(r.stdout).toMatch(/DIE the archive must hold exactly one image with exactly one tag/);
      untouched();
      expect(imageId(GOOD_TAG)).toBe('');
    });

    it('the good image with a second tag (a ROLLBACK tag): refused, the rollback tag keeps its image', () => {
      expect(d('tag', images.fresh, GOOD_TAG).status).toBe(0);
      expect(d('tag', images.fresh, RESTORE_TAG).status).toBe(0);
      const bad = save('two-tags.tar', GOOD_TAG, RESTORE_TAG);
      expect(d('tag', images.restore, RESTORE_TAG).status).toBe(0);
      d('image', 'rm', GOOD_TAG);
      const r = load(bad, images.fresh);
      expect(r.stdout).toMatch(/DIE the archive must hold exactly one image with exactly one tag/);
      untouched();
    });

    it('index.json renamed to the rollback tag (manifest.json still right): refused before load', () => {
      const bad = tamper(
        good,
        'index-renamed.tar',
        'index.json',
        `.manifests[0].annotations["io.containerd.image.name"] = "docker.io/${RESTORE_TAG}"`,
      );
      const r = load(bad, images.fresh);
      expect(r.stdout).toMatch(/DIE the archive's index.json names another or a second image/);
      untouched();
      expect(imageId(GOOD_TAG)).toBe('');
    });

    it('a legacy repositories file naming the running tag: refused before load', () => {
      const x = join(dir, 'legacy');
      const res = spawnSync('bash', [
        '-c',
        `set -e; mkdir -p ${x}; tar -xf ${good} -C ${x}; ` +
          `printf '{"${RUNNING_TAG.split(':')[0]}":{"${RUNNING_TAG.split(':')[1]}":"x"}}' > ${x}/repositories; ` +
          // A classic store's `docker save` already has one: it is replaced, never doubled.
          `cd ${x}; tar -cf ${join(dir, 'legacy.tar')} $(tar -tf ${good} | grep -v '/$' | grep -vx repositories | tr '\\n' ' ') repositories; ` +
          // And an archive with two repositories entries (which one would docker load use?).
          `tar -cf ${join(dir, 'legacy-twice.tar')} $(tar -tf ${good} | grep -v '/$' | grep -vx repositories | tr '\\n' ' ') repositories repositories`,
      ]);
      expect(res.status, res.stderr.toString()).toBe(0);
      chmodSync(join(dir, 'legacy.tar'), 0o644);
      chmodSync(join(dir, 'legacy-twice.tar'), 0o644);
      const r = load(join(dir, 'legacy.tar'), images.fresh);
      expect(r.stdout).toMatch(/DIE the archive's repositories file names another tag/);
      untouched();
      const twice = load(join(dir, 'legacy-twice.tar'), images.fresh);
      expect(twice.stdout).toMatch(/DIE the archive must hold exactly one manifest.json/);
      untouched();
    });

    it('a production tag in the archive itself (not a DEV portal-web tag): refused', () => {
      expect(
        d('tag', images.fresh, `${PREFIX}/portal-web:${'f'.repeat(12)}-${'3'.repeat(12)}`).status,
      ).toBe(0);
      const bad = save('prod-tag.tar', `${PREFIX}/portal-web:${'f'.repeat(12)}-${'3'.repeat(12)}`);
      d('image', 'rm', `${PREFIX}/portal-web:${'f'.repeat(12)}-${'3'.repeat(12)}`);
      const r = load(bad, images.fresh);
      expect(r.stdout).toMatch(/is not a DEV portal-web tag/);
    });

    it('another image than the accepted ID: refused before load', () => {
      const r = load(good, images.evil);
      expect(r.stdout).toMatch(/DIE the archive holds image .* not the accepted/);
      expect(imageId(GOOD_TAG)).toBe('');
    });

    it('its DEV tag already names another image here: refused, that tag unchanged', () => {
      expect(d('tag', images.evil, GOOD_TAG).status).toBe(0);
      const r = load(good, images.fresh);
      expect(r.stdout).toMatch(/already names image .* here: refused, nothing loaded/);
      expect(imageId(GOOD_TAG)).toBe(images.evil);
      d('image', 'rm', GOOD_TAG);
    });
  },
);
