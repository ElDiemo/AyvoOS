import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hotel portal steps of scripts/deploy-prod.sh (doc 064 A1, review 5858165597), run as the real
 * functions taken from the script:
 * - P1: a public portal that fails its public check is never left open — it goes back to the image
 *   that was the verified public portal (verified again) or only portal-web is stopped and the
 *   closed route is checked; the OS, QR, ID and marketing are checked again and never restarted.
 *   An OS deployment never opens a portal-web that was not verified as public. Docker, Compose
 *   and curl are test doubles that record every call (no production project is touched); the
 *   public check itself is the real verify_portal_release, made to fail by the edge's answers.
 */
const root = resolve(import.meta.dirname, '../../..');
const script = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');
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
