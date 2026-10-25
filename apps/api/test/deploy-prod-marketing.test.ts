import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The marketing release steps of scripts/deploy-prod.sh (ADR 0040; review MKT70-R1/R2/R3), run as
 * the real functions taken from the script (only `curl`/`docker compose` are given test doubles
 * where the network or a production project would be needed):
 * - verify_marketing_release refuses no TLS, a TLS error, 503 and a wrong www answer — nothing
 *   is "verified" without valid HTTPS on both names; verify_marketing_edge only reports a named
 *   not-ready state, never success;
 * - load_marketing_image accepts exactly the accepted image ID: the same content built with a
 *   changed Dockerfile is refused (Docker, CI or AYVO_DOCKER_TESTS=1);
 * - start_marketing: a wrong artifact or a container that never becomes healthy restores the
 *   previous image by its image ID — also when the new build has the same source revision
 *   (real Compose on a throwaway project; Docker as above).
 */
const root = resolve(import.meta.dirname, '../../..');
const script = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const bash = (body: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { ...process.env, ...env } });

/** The source of one function of the script (from `name() {` to its closing brace). */
function fn(name: string): string {
  const i = script.indexOf(`\n${name}() {`);
  expect(i, name).toBeGreaterThan(0);
  return script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
}
const HELPERS = [
  'set -Eeuo pipefail',
  'log() { echo "LOG $*"; }',
  'ok() { echo "OK $*"; }',
  'warn() { echo "WARN $*"; }',
  'die() { echo "DIE $*"; exit 1; }',
].join('\n');

describe('verify_marketing_release: only valid HTTPS on apex and www counts (MKT70-R2)', () => {
  const APEX = 'ayvo.example.test';
  /**
   * curl double: answers by host/URL/method. `fail` = "<host>" for a TLS/connection error
   * (exit 60, no output); `status` overrides the answer of a URL.
   */
  function stub(over: { fail?: string; status?: Record<string, string> } = {}) {
    const answers: Record<string, string> = {
      [`GET https://${APEX}/`]: '200 ',
      [`GET https://www.${APEX}/cz/`]: `301 https://${APEX}/cz/`,
      ...over.status,
    };
    const cases = Object.entries(answers)
      .map(([k, v]) => `    "${k}") printf '%s' '${v}' ;;`)
      .join('\n');
    return `
curl() {
  local method=GET url="" host_header="" a
  while (($#)); do
    case $1 in -X) method=$2; shift ;; -H) host_header=$2; shift ;; https://*) url=$1 ;; esac
    shift
  done
  local host=\${url#https://}; host=\${host%%/*}
  ${over.fail ? `[[ $host == "${over.fail}" ]] && return 60` : ''}
  [[ -n $host_header ]] && { printf '421 '; return 0; }
  [[ $method != GET ]] && { printf '405 '; return 0; }
  case "$method $url" in
${cases}
    *) printf '404 ' ;;
  esac
}`;
  }
  const verify = (over: Parameters<typeof stub>[0] = {}) =>
    bash(
      `${HELPERS}\n${stub(over)}\nDOMAIN=os.example.test; MARKETING_DOMAIN=${APEX}\n${fn('verify_marketing_release')}\n` +
        `if (verify_marketing_release 192.0.2.10); then echo RECORD SUCCESS; else echo RECORD UNVERIFIED; fi`,
    );

  it('everything right: verified', () => {
    const res = verify();
    expect(res.stdout).toContain('RECORD SUCCESS');
  });

  it.each([
    ['no valid HTTPS on the apex', { fail: APEX }],
    ['no valid HTTPS on www', { fail: `www.${APEX}` }],
    ['the site answers 503', { status: { [`GET https://${APEX}/`]: '503 ' } }],
    [
      'www answers 200 instead of the redirect',
      { status: { [`GET https://www.${APEX}/cz/`]: '200 ' } },
    ],
    [
      'www redirects elsewhere',
      { status: { [`GET https://www.${APEX}/cz/`]: '301 https://evil.example/' } },
    ],
    ['an OS path answers', { status: { [`GET https://${APEX}/api/health`]: '200 ' } }],
  ])('%s: refused, recorded as UNVERIFIED', (_, over) => {
    const res = verify(over);
    expect(res.stdout).toContain('DIE');
    expect(res.stdout).toContain('RECORD UNVERIFIED');
    expect(res.stdout).not.toContain('RECORD SUCCESS');
  });

  it('the main flow records SUCCESS only after the strict verification passed', () => {
    for (const mode of ['  marketing)\n', '  marketing-rollback)\n']) {
      const block = script.slice(
        script.indexOf(mode),
        script.indexOf('\n    ;;\n', script.indexOf(mode)),
      );
      const verifyAt = block.indexOf('verify_marketing_release');
      const successAt = block.indexOf('record_marketing SUCCESS');
      expect(verifyAt).toBeGreaterThan(0);
      expect(successAt).toBeGreaterThan(verifyAt);
      expect(block.indexOf('record_marketing UNVERIFIED')).toBeGreaterThan(verifyAt);
      expect(block).not.toContain('verify_marketing_edge');
    }
  });

  it('after an OS deployment the edge is only reported as PREPARED, NOT LIVE — never success', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ayvo-mk-edge-'));
    mkdirSync(join(tmp, 'deploy/prod'), { recursive: true });
    writeFileSync(join(tmp, 'deploy/prod/compose.marketing.yml'), '');
    const res = bash(
      `${HELPERS}
curl() { local url=\${@: -1}; case $url in
  http://*acme-challenge*) printf '404' ;;
  http://*) printf '301 https://%s' "\${url#http://}" ;;
  https://*) return 60 ;;
esac; }
release_dir() { echo ${tmp}; }
MARKETING_DOMAIN=${APEX}; AYVO_RELEASE=x
${fn('verify_marketing_edge')}
verify_marketing_edge 192.0.2.10; echo "EXIT $?"`,
    );
    expect(res.stdout).toContain('EXIT 0');
    expect(res.stdout.match(/PREPARED, NOT LIVE/g)?.length).toBe(2);
    expect(res.stdout).not.toMatch(/SUCCESS/);
  });
});

describe.skipIf(!WANT_DOCKER)('load_marketing_image: exactly the accepted image (MKT70-R1)', () => {
  const id = randomBytes(4).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-mk-image-'));
  const revision = 'a'.repeat(40);
  const images = { a: `ayvo-mk-a-${id}:t`, b: `ayvo-mk-b-${id}:t` };
  const imageId = (ref: string) =>
    spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
      encoding: 'utf8',
    }).stdout.trim();
  const archive = (ref: string, name: string) => {
    const file = join(dir, name);
    const res = spawnSync('bash', ['-c', `docker save ${ref} | gzip -n > ${file}`]);
    expect(res.status).toBe(0);
    chmodSync(file, 0o644);
    return file;
  };
  const load = (file: string, expected: string) =>
    bash(
      `${HELPERS}\nIMAGE_PREFIX=ayvo-mk-test-${id}\n${fn('load_marketing_image')}\n` +
        `load_marketing_image ${file} ${expected}; echo "LOADED $MARKETING_RELEASE"`,
    );
  let a = '';
  let b = '';

  beforeAll(() => {
    const build = (tag: string, context: string) =>
      expect(
        spawnSync('docker', [
          'build',
          '-q',
          '--label',
          `org.opencontainers.image.revision=${revision}`,
          '-t',
          tag,
          context,
        ]).status,
      ).toBe(0);
    build(images.a, join(root, 'apps/marketing'));
    // The same site and Caddyfile (the same content digest), a changed Dockerfile.
    const changed = join(dir, 'changed');
    cpSync(join(root, 'apps/marketing'), changed, { recursive: true });
    writeFileSync(
      join(changed, 'Dockerfile'),
      `${readFileSync(join(changed, 'Dockerfile'), 'utf8')}LABEL tampered=yes\n`,
    );
    build(images.b, changed);
    const digest = (ctx: string) =>
      spawnSync('sh', ['./site-digest.sh', 'Caddyfile', 'site'], { cwd: ctx, encoding: 'utf8' })
        .stdout;
    expect(digest(changed)).toBe(digest(join(root, 'apps/marketing')));
    a = archive(images.a, 'a.tar.gz');
    b = archive(images.b, 'b.tar.gz');
  }, 300_000);

  afterAll(() => {
    spawnSync('bash', [
      '-c',
      `docker image rm -f ${images.a} ${images.b} ayvo-mk-test-${id}/marketing:${revision.slice(0, 12)}-${a ? imageId(images.a).slice(7, 19) : 'none'} >/dev/null 2>&1`,
    ]);
  });

  it('the accepted archive loads and is tagged with its revision', () => {
    const res = load(a, imageId(images.a));
    expect(res.stdout, res.stdout).toContain(
      `LOADED ${revision.slice(0, 12)}-${imageId(images.a).slice(7, 19)}`,
    );
  });

  it('the same content with a changed Dockerfile is refused under the accepted identity', () => {
    expect(imageId(images.b)).not.toBe(imageId(images.a));
    const res = load(b, imageId(images.a));
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/DIE the archive holds image sha256:[0-9a-f]+, not the accepted/);
    expect(res.stdout).not.toContain('LOADED');
  });

  it('an archive writable by others is refused before loading', () => {
    const open = join(dir, 'open.tar.gz');
    cpSync(a, open);
    chmodSync(open, 0o666);
    const res = load(open, imageId(images.a));
    expect(res.stdout).toContain('DIE --image-archive');
  });
});

describe.skipIf(!WANT_DOCKER)(
  'start_marketing: a failed switch restores the previous image',
  () => {
    const id = randomBytes(4).toString('hex');
    const project = `ayvo-mk-swap-${id}`;
    const prefix = `ayvo-mk-swap-${id}`;
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-mk-swap-'));
    // The production image name (compose.marketing.yml), with tags unique to this run.
    const tagOf = (name: string) => `swap${id}${name}`;
    const image = (name: string) => `ayvo-prod/marketing:${tagOf(name)}`;
    const idOf = (ref: string) =>
      spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
        encoding: 'utf8',
      }).stdout.trim();
    let good = '';
    let goodDigest = '';
    /** Further tags the tests create, removed after the container. */
    const extra: string[] = [];

    beforeAll(() => {
      expect(
        spawnSync('docker', ['build', '-q', '-t', image('good'), join(root, 'apps/marketing')])
          .status,
      ).toBe(0);
      good = idOf(image('good'));
      goodDigest = spawnSync('sh', ['./site-digest.sh', 'Caddyfile', 'site'], {
        cwd: join(root, 'apps/marketing'),
        encoding: 'utf8',
      }).stdout.trim();
      // A wrong artifact (other content, healthy) and one that never becomes healthy.
      const other = join(dir, 'other');
      cpSync(join(root, 'apps/marketing'), other, { recursive: true });
      writeFileSync(join(other, 'site/robots.txt'), 'User-agent: *\nDisallow: /\n');
      expect(spawnSync('docker', ['build', '-q', '-t', image('wrong'), other]).status).toBe(0);
      writeFileSync(
        join(dir, 'Dockerfile.broken'),
        `FROM ${image('good')}\nCMD ["caddy", "run", "--config", "/nonexistent"]\n`,
      );
      expect(
        spawnSync('docker', [
          'build',
          '-q',
          '-t',
          image('broken'),
          '-f',
          join(dir, 'Dockerfile.broken'),
          dir,
        ]).status,
      ).toBe(0);
      mkdirSync(join(dir, 'secrets'));
      for (const f of ['prod.env', 'prod-auth.env', 'prod-s3.env'])
        writeFileSync(join(dir, 'secrets', f), '');
    }, 300_000);

    afterAll(() => {
      spawnSync('bash', [
        '-c',
        `docker rm -f ${project}-marketing-1 >/dev/null 2>&1; ` +
          `docker network rm ${project}_marketing >/dev/null 2>&1; docker image rm -f ${image('good')} ${image('wrong')} ${image('broken')} >/dev/null 2>&1; ` +
          `docker image rm -f ayvo-prod/marketing:restore-${good.slice(7, 19)} ${extra.join(' ')} >/dev/null 2>&1`,
      ]);
    });

    /** start_marketing of the script against a real throwaway Compose project (only `marketing`). */
    const start = (tag: string, expected: string, previous: string) =>
      bash(
        `${HELPERS}
PROJECT=${project}
compose() {
  PROD_DOMAIN=os.example.test PROD_TAILNET_IPV4=100.64.0.2 PROD_PUBLIC_IPV4=192.0.2.10 \\
  QR_DOMAIN=qr.example.test MARKETING_DOMAIN=ayvo.example.test ACME_EMAIL=ops@example.test \\
  AYVO_RELEASE=x AYVO_RELEASE_DIR=${dir} AYVO_PROD_SECRETS_DIR=${dir}/secrets \\
  POSTGRES_USER=x POSTGRES_PASSWORD=x POSTGRES_DB=x PUBLIC_QR_BASE_URL=https://qr.example.test \\
  MARKETING_RELEASE=$MARKETING_RELEASE \\
  docker compose -p ${project} -f ${root}/deploy/prod/compose.yml -f ${root}/deploy/prod/compose.marketing.yml \\
    --env-file ${dir}/secrets/prod.env "$@" 2>/dev/null
}
# A short wait for the test (the script's own waits up to 3 minutes).
wait_healthy() { local i s; for ((i = 0; i < 20; i++)); do s=$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q "$1")" 2>/dev/null || true); [[ $s == healthy ]] && return 0; sleep 1; done; return 1; }
running_marketing_digest() { docker exec "$PROJECT-marketing-1" site-digest /etc/caddy/Caddyfile /srv; }
sed() { command sed "$@"; }
MARKETING_RELEASE=${tagOf(tag)}; MARKETING_PREVIOUS_IMAGE=${previous}
IMAGE_PREFIX=ayvo-prod
${fn('start_marketing')}
start_marketing ${expected} ${goodDigest}; echo "EXIT $?"`,
      );
    const running = () =>
      spawnSync('docker', ['inspect', '--format', '{{.Image}}', `${project}-marketing-1`], {
        encoding: 'utf8',
      }).stdout.trim();

    it('the accepted image starts and is checked (image ID and content)', () => {
      const res = start('good', good, '');
      expect(res.stdout, res.stdout).toContain('EXIT 0');
      expect(running()).toBe(good);
    }, 120_000);

    it('a wrong artifact (other content) is replaced by the previous image again; the step fails', () => {
      const res = start('wrong', idOf(image('wrong')), good);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(
        `DIE the marketing release did not start; the previous image ${good} runs again`,
      );
      expect(running()).toBe(good);
    }, 120_000);

    it('a container that never becomes healthy: the previous image runs again; the step fails', () => {
      const res = start('broken', idOf(image('broken')), good);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('runs again');
      expect(running()).toBe(good);
    }, 120_000);

    it('the same source revision with another image ID never takes over the running one; a failed switch restores it (MKT70-R3)', () => {
      // The running image and a second (broken) build of the SAME revision, loaded from its
      // archive with the script's own load_marketing_image, then switched to and failing.
      const revision = 'b'.repeat(40);
      const labelled = (name: string, from: string) => {
        writeFileSync(
          join(dir, `Dockerfile.${name}`),
          `FROM ${from}\nLABEL org.opencontainers.image.revision=${revision}\n`,
        );
        expect(
          spawnSync('docker', [
            'build',
            '-q',
            '-t',
            image(name),
            '-f',
            join(dir, `Dockerfile.${name}`),
            dir,
          ]).status,
        ).toBe(0);
        return idOf(image(name));
      };
      const first = labelled('rev1', image('good'));
      const second = labelled('rev2', image('broken'));
      expect(second).not.toBe(first);
      // The first build is what an earlier --marketing started (its tag from load_marketing_image).
      const firstTag = `${revision.slice(0, 12)}-${first.slice(7, 19)}`;
      extra.push(
        `ayvo-prod/marketing:${firstTag}`,
        `ayvo-prod/marketing:${revision.slice(0, 12)}-${second.slice(7, 19)}`,
        `ayvo-prod/marketing:restore-${first.slice(7, 19)}`,
        image('rev1'),
        image('rev2'),
      );
      expect(spawnSync('docker', ['tag', first, `ayvo-prod/marketing:${firstTag}`]).status).toBe(0);
      expect(start('rev1', first, '').stdout).toContain('EXIT 0');
      const archive = join(dir, 'rev2.tar.gz');
      expect(
        spawnSync('bash', ['-c', `docker save ${image('rev2')} | gzip -n > ${archive}`]).status,
      ).toBe(0);
      chmodSync(archive, 0o644);
      const res = bash(
        `${HELPERS}
PROJECT=${project}
IMAGE_PREFIX=ayvo-prod
${fn('load_marketing_image')}
MARKETING_PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' "$PROJECT-marketing-1")"
load_marketing_image ${archive} ${second}
echo "TAG $MARKETING_RELEASE"`,
      );
      expect(res.stdout, res.stdout).toContain(
        `TAG ${revision.slice(0, 12)}-${second.slice(7, 19)}`,
      );
      // The earlier tag still names the first image: nothing was overwritten before the start.
      expect(idOf(`ayvo-prod/marketing:${firstTag}`)).toBe(first);
      spawnSync('docker', ['tag', second, image('rev2')]);
      const swap = start('rev2', second, first);
      expect(swap.status).toBe(1);
      expect(swap.stdout).toContain(`the previous image ${first} runs again`);
      expect(running()).toBe(first);
    }, 240_000);

    it('an existing tag naming another image is refused before anything is changed (MKT70-R3)', () => {
      // A labelled build whose tag (revision + image ID) is already taken by another image.
      const archive = join(dir, 'revc.tar.gz');
      const revision = 'c'.repeat(40);
      writeFileSync(
        join(dir, 'Dockerfile.revc'),
        `FROM ${image('good')}\nLABEL org.opencontainers.image.revision=${revision}\n`,
      );
      expect(
        spawnSync('docker', [
          'build',
          '-q',
          '-t',
          image('revc'),
          '-f',
          join(dir, 'Dockerfile.revc'),
          dir,
        ]).status,
      ).toBe(0);
      const revc = idOf(image('revc'));
      const tag = `ayvo-prod/marketing:${revision.slice(0, 12)}-${revc.slice(7, 19)}`;
      extra.push(tag, image('revc'));
      expect(spawnSync('docker', ['tag', image('wrong'), tag]).status).toBe(0);
      expect(
        spawnSync('bash', ['-c', `docker save ${image('revc')} | gzip -n > ${archive}`]).status,
      ).toBe(0);
      chmodSync(archive, 0o644);
      const res = bash(
        `${HELPERS}\nIMAGE_PREFIX=ayvo-prod\n${fn('load_marketing_image')}\nload_marketing_image ${archive} ${revc}; echo LOADED`,
      );
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(
        `DIE ${tag} already names image ${idOf(image('wrong'))}: refused`,
      );
      expect(idOf(tag)).toBe(idOf(image('wrong')));
    }, 240_000);
  },
);
