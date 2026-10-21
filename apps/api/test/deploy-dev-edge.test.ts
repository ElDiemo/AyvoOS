import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The tailnet-only edge of the DEV preview (ADR 0026, PR #33 review TS33-R1/R2):
 * - every {$VAR} of the Caddyfile/Corefile is passed to its container by deploy/dev/compose.yml;
 * - the REAL Compose `dns` service answers the domain over UDP and TCP and refuses other names;
 * - scripts/dev-edge-backup.sh saves the running Caddy exactly as it runs and restores it, also
 *   after a partly failed switch; deploy-dev.sh --edge switches nothing when that backup fails.
 * Docker tests run on separate, throwaway Compose projects (never the live `ayvo-dev-preview`) and
 * are skipped where Docker or dig is missing. All values are fictional fixtures.
 */
const root = resolve(import.meta.dirname, '../../..');
const devDir = join(root, 'deploy/dev');
const helper = join(root, 'scripts/dev-edge-backup.sh');

const run = (cmd: string, args: string[], env: Record<string, string> = {}, cwd = root) =>
  spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
const hasDocker = run('docker', ['compose', 'version']).status === 0;
const hasDig = run('dig', ['-v']).status === 0;

/** Environment keys of a service in deploy/dev/compose.yml (plain YAML, read textually). */
function serviceEnv(service: string): string[] {
  const text = readFileSync(join(devDir, 'compose.yml'), 'utf8');
  const block = text.split(new RegExp(`^  ${service}:\\n`, 'm'))[1]!.split(/^ {2}\S/m)[0]!;
  const env = block.split(/^ {4}environment:\n/m)[1]!.split(/^ {4}\S/m)[0]!;
  return [...env.matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((m) => m[1]!);
}
const placeholders = (file: string) => [
  ...new Set(
    [...readFileSync(join(devDir, file), 'utf8').matchAll(/\{\$([A-Z0-9_]+)\}/g)].map((m) => m[1]!),
  ),
];

describe('every placeholder of the edge configuration reaches its container (TS33-R1)', () => {
  it.each([
    ['Corefile', 'dns'],
    ['Caddyfile', 'caddy'],
  ])('%s → service %s', (file, service) => {
    const vars = placeholders(file);
    expect(vars.length).toBeGreaterThan(0);
    expect(serviceEnv(service)).toEqual(expect.arrayContaining(vars));
  });
});

describe('tailnet + application identity without a shared Basic Auth password (ADR 0030)', () => {
  it('removes only Basic Auth and retains the real-peer check and application upstreams', () => {
    const caddy = readFileSync(join(devDir, 'Caddyfile'), 'utf8');
    expect(caddy).not.toMatch(/^\s*basic_auth\s*\{/m);
    expect(serviceEnv('caddy')).not.toContain('DEV_BASIC_AUTH_USER');
    expect(serviceEnv('caddy')).not.toContain('DEV_BASIC_AUTH_HASH');
    expect(caddy).toContain('@outside not remote_ip 100.64.0.0/10');
    expect(caddy).toMatch(/handle @outside\s*\{\s*abort\s*\}/);
    expect(caddy).toContain('reverse_proxy api:4000');
    expect(caddy).toContain('reverse_proxy web:3000');
    expect(caddy).toContain('X-Robots-Tag "noindex, nofollow"');
  });

  it.skipIf(!hasDocker)(
    'adapts the real Caddyfile with no Basic Auth variables or middleware',
    () => {
      const r = run('docker', [
        'run',
        '--rm',
        '--mount',
        `type=bind,src=${join(devDir, 'Caddyfile')},dst=/etc/caddy/Caddyfile,readonly`,
        '-e',
        'DEV_DOMAIN=dev.example-preview.test',
        '-e',
        'ACME_EMAIL=ops@ayvo.test',
        'caddy:2-alpine',
        'caddy',
        'adapt',
        '--config',
        '/etc/caddy/Caddyfile',
      ]);
      expect(r.status, r.stderr).toBe(0);
      const config = JSON.parse(r.stdout);
      const text = JSON.stringify(config);
      expect(text).not.toContain('http_basic');
      expect(text).not.toContain('authentication');
      expect(text).toContain('100.64.0.0/10');
      expect(text).toContain('api:4000');
      expect(text).toContain('web:3000');
    },
  );

  it('verifies edge requests without credentials and rejects a Basic challenge', () => {
    const bin = join(dir, 'edge-http-bin');
    run('mkdir', ['-p', bin]);
    // The real edge helper is exercised, not a copied implementation. No network or credentials.
    const source = readFileSync(join(root, 'scripts/deploy-dev.sh'), 'utf8');
    const helpers = source.split(/^# --- verification -+\n/m)[1]!.split('# --- tailnet only')[0]!;
    writeFileSync(
      join(bin, 'curl'),
      `#!/usr/bin/env bash
[[ "$*" != *--config* && "$*" != *--user* && "$*" != *Authorization* ]] || exit 90
if [[ "$*" == *heartbeat* ]]; then
  [[ "$*" == *'--request POST'* ]] || exit 91
  printf '401\\nnoindex, nofollow\\n\\napplication/json\\n\\n'
else
  printf '200\\nnoindex, nofollow\\n\\ntext/html\\n%s\\n' "\${CHALLENGE:-}"
fi
`,
    );
    chmodSync(join(bin, 'curl'), 0o755);
    const script = `set -euo pipefail
declare -A CFG=([DEV_DOMAIN]=dev.example-preview.test)
TAILNET_IPV4=100.64.0.1
EDGE_BODY="$1"
die() { echo "$*" >&2; exit 1; }
warn() { echo "$*" >&2; }
ok() { :; }
${helpers}
expect_edge login https://dev.example-preview.test/login 200
expect_edge agent https://dev.example-preview.test/api/agent/v1/heartbeat 401 POST
`;
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const pass = run('bash', ['-c', script, 'edge-test', join(dir, 'http-body')], env);
    expect(pass.status, pass.stderr).toBe(0);
    const fail = run('bash', ['-c', script, 'edge-test', join(dir, 'http-body')], {
      ...env,
      CHALLENGE: 'Basic realm="preview"',
    });
    expect(fail.status).not.toBe(0);
    expect(fail.stderr).toContain('unexpected WWW-Authenticate');
  });
});

const get = (port: number) =>
  run('curl', ['-s', '-m', '3', `http://127.0.0.1:${port}/`]).stdout.trim();
const until = (port: number, body: string) => {
  for (let i = 0; i < 30 && get(port) !== body; i++) run('sleep', ['0.5']);
  return get(port);
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayvo-edge-'));
  writeFileSync(
    join(dir, 'fixture.env'),
    [
      'DEV_DOMAIN=dev.example-preview.test',
      'ACME_EMAIL=ops@ayvo.test',
      'POSTGRES_USER=ayvo',
      `POSTGRES_PASSWORD=${'p'.repeat(32)}`,
      'POSTGRES_DB=ayvo',
      'WORKOS_API_KEY=sk_test_FIXTURE_not_a_real_key_000',
      'WORKOS_CLIENT_ID=client_FIXTURE0000000000000000',
      'WORKOS_JWT_ISSUER=https://api.workos.com/user_management/client_FIXTURE0000000000000000',
      '',
    ].join('\n'),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasDocker || !hasDig)('the real Compose dns service (TS33-R1)', () => {
  const project = `ayvo-test-dns-${process.pid}`;
  const address = '127.0.0.77';
  const compose = (...args: string[]) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        join(devDir, 'compose.yml'),
        '--env-file',
        join(dir, 'fixture.env'),
        ...args,
      ],
      { DEV_TAILNET_IPV4: address },
    );
  afterAll(() => compose('down', '--remove-orphans'));

  it('answers A over UDP and TCP and refuses every other name', () => {
    const up = compose('up', '--detach', '--no-deps', '--wait', 'dns');
    expect(up.status, up.stderr).toBe(0);
    const dig = (...a: string[]) => run('dig', ['+time=2', '+tries=2', `@${address}`, ...a]).stdout;
    for (const proto of ['+notcp', '+tcp']) {
      expect(dig(proto, '+short', 'dev.example-preview.test', 'A').trim()).toBe(address);
      expect(dig(proto, 'example.com', 'A')).toContain('status: REFUSED');
    }
    expect(dig('+short', 'dev.example-preview.test', 'AAAA').trim()).toBe('');
    expect(dig('x.dev.example-preview.test', 'A')).toContain('status: NXDOMAIN');
  });
});

describe.skipIf(!hasDocker)('edge backup and restore (TS33-R2, TS33-R3)', () => {
  const project = `ayvo-test-edge-${process.pid}`;
  const [oldPort, newPort] = [18000 + (process.pid % 1000), 19000 + (process.pid % 1000)];
  let work: string;
  let backups: string;
  let tag: string;

  const compose = (port: number, extra = '') => `name: ${project}
services:
  caddy:
    image: caddy:2-alpine
    ports: ['127.0.0.1:${port}:80']
    volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro']
  api:
    image: ayvo-edgetest/api:\${AYVO_IMAGE_TAG:-local}
    command: ['sleep', '3600']
${extra}`;
  const dc = (...args: string[]) =>
    run(
      'docker',
      ['compose', '--project-directory', work, '-f', join(work, 'compose.yml'), ...args],
      {
        AYVO_IMAGE_TAG: tag,
      },
    );
  const git = (...args: string[]) => run('git', ['-C', work, ...args]);
  const commit = (message: string) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@ayvo.test', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').stdout.trim();
  };

  beforeAll(() => {
    work = join(dir, 'work');
    backups = join(dir, 'backups');
    run('mkdir', ['-p', work]);
    git('init', '-q');
    writeFileSync(join(work, 'compose.yml'), compose(oldPort));
    writeFileSync(join(work, 'Caddyfile'), ':80 {\n\trespond "old"\n}\n');
    chmodSync(join(work, 'Caddyfile'), 0o644);
    // Images are tagged <sha12>-<time> by deploy-dev.sh: the commit the old edge was deployed from.
    tag = `${commit('old edge').slice(0, 12)}-20261017T000000Z`;
    run('docker', ['pull', '-q', 'alpine:3.20']);
    run('docker', ['tag', 'alpine:3.20', `ayvo-edgetest/api:${tag}`]);
    const up = dc('up', '--detach', 'caddy', 'api');
    expect(up.status, up.stderr).toBe(0);
    expect(until(oldPort, 'old')).toBe('old');
  });
  afterAll(() => {
    run('docker', [
      'compose',
      '-p',
      project,
      '-f',
      join(work, 'compose.yml'),
      'down',
      '--remove-orphans',
    ]);
    run('docker', ['rmi', `ayvo-edgetest/api:${tag}`]);
  });

  it('refuses to back up a project without a running caddy', () => {
    const r = run(helper, ['backup', `${project}-missing`, backups, join(dir, 'fixture.env')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('expected exactly one running caddy container');
  });

  it('old caddy running, checkout already on the NEW compose: backup and restore still work (TS33-R3)', () => {
    // The checkout moves to the new main before the switch: new Compose (other port, a dns that
    // fails to start) and a new Caddyfile on disk (new inode), while the OLD caddy still runs.
    writeFileSync(
      join(work, 'compose.yml'),
      compose(newPort, "  dns:\n    image: alpine:3.20\n    command: ['false']\n"),
    );
    writeFileSync(join(work, 'Caddyfile.next'), ':80 {\n\trespond "new"\n}\n');
    renameSync(join(work, 'Caddyfile.next'), join(work, 'Caddyfile'));
    commit('new edge');

    // The match check stays strict: without the git history no candidate reproduces the old caddy.
    renameSync(join(work, '.git'), join(work, '.git-away'));
    const refused = run(helper, ['backup', project, backups, join(dir, 'fixture.env')]);
    renameSync(join(work, '.git-away'), join(work, '.git'));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('reproduces the running caddy');

    const b = run(helper, ['backup', project, backups, join(dir, 'fixture.env')]);
    expect(b.status, b.stderr).toBe(0);
    const saved = b.stdout.trim();
    const complete = readFileSync(join(saved, 'COMPLETE'), 'utf8');
    expect(complete).toContain(`compose=git:${tag.slice(0, 12)}`);
    expect(readFileSync(join(saved, 'compose.yml'), 'utf8')).toContain(`127.0.0.1:${oldPort}:80`);
    expect(readFileSync(join(saved, 'Caddyfile'), 'utf8')).toContain('respond "old"');
    expect(readFileSync(join(saved, 'runtime.env'), 'utf8')).toBe(`AYVO_IMAGE_TAG=${tag}\n`);
    expect(readFileSync(join(saved, 'ports'), 'utf8').trim()).toBe(`127.0.0.1:${oldPort}->80/tcp`);

    // The switch fails half-way: the new caddy runs on the new port, dns does not start.
    dc('up', '--detach', '--no-deps', 'caddy', 'dns');
    expect(until(newPort, 'new')).toBe('new');
    expect(get(oldPort)).toBe('');

    const r = run(helper, ['restore', saved, join(dir, 'fixture.env')]);
    expect(r.status, r.stderr).toBe(0);
    expect(until(oldPort, 'old')).toBe('old');
    expect(get(newPort)).toBe('');
    const left = run('docker', [
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      'label=com.docker.compose.service=dns',
    ]);
    expect(left.stdout.trim()).toBe('');
  });

  it('refuses to restore a tampered backup', () => {
    const b = run(helper, ['backup', project, backups, join(dir, 'fixture.env')]);
    expect(b.status, b.stderr).toBe(0);
    const saved = b.stdout.trim();
    writeFileSync(join(saved, 'Caddyfile'), ':80 {\n\trespond "tampered"\n}\n');
    const r = run(helper, ['restore', saved, join(dir, 'fixture.env')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('checksums');
    expect(until(oldPort, 'old')).toBe('old');
  });
});

describe.skipIf(!hasDocker)('restore of a tailnet-era backup from a clean shell (TS33-R4)', () => {
  const project = `ayvo-test-edge-ts-${process.pid}`;
  const port = 17000 + (process.pid % 1000);
  const tag = 't4';
  let work: string;
  // Like deploy/dev/compose.yml after ADR 0026: the address is interpolated, required, and passed
  // to the container; only the deploy process exports it.
  const compose = `name: ${project}
services:
  caddy:
    image: caddy:2-alpine
    ports: ['\${DEV_TAILNET_IPV4:?set by deploy}:${port}:80']
    environment:
      DEV_TAILNET_IPV4: \${DEV_TAILNET_IPV4}
    volumes: ['./Caddyfile:/etc/caddy/Caddyfile:ro']
  api:
    image: ayvo-edgetest/api:\${AYVO_IMAGE_TAG:-local}
    command: ['sleep', '3600']
`;
  /** A shell without DEV_TAILNET_IPV4 or AYVO_IMAGE_TAG, like a new SSH session. */
  const clean = (cmd: string, args: string[]) => {
    const env = { ...process.env };
    delete env.DEV_TAILNET_IPV4;
    delete env.AYVO_IMAGE_TAG;
    return spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8' });
  };

  beforeAll(() => {
    work = join(dir, 'work-ts');
    run('mkdir', ['-p', work]);
    writeFileSync(join(work, 'compose.yml'), compose);
    writeFileSync(join(work, 'Caddyfile'), ':80 {\n\trespond "tailnet"\n}\n');
    chmodSync(join(work, 'Caddyfile'), 0o644);
    run('docker', ['tag', 'alpine:3.20', `ayvo-edgetest/api:${tag}`]);
    const up = run(
      'docker',
      [
        'compose',
        '--project-directory',
        work,
        '-f',
        join(work, 'compose.yml'),
        'up',
        '--detach',
        'caddy',
        'api',
      ],
      {
        AYVO_IMAGE_TAG: tag,
        DEV_TAILNET_IPV4: '127.0.0.1',
      },
    );
    expect(up.status, up.stderr).toBe(0);
    expect(until(port, 'tailnet')).toBe('tailnet');
  });
  afterAll(() => {
    run(
      'docker',
      ['compose', '-p', project, '-f', join(work, 'compose.yml'), 'down', '--remove-orphans'],
      {
        DEV_TAILNET_IPV4: '127.0.0.1',
      },
    );
    run('docker', ['rmi', `ayvo-edgetest/api:${tag}`]);
  });

  it('saves the runtime values and restores without any exported address', () => {
    const b = clean(helper, ['backup', project, join(dir, 'backups-ts'), join(dir, 'fixture.env')]);
    expect(b.status, b.stderr).toBe(0);
    const saved = b.stdout.trim();
    expect(readFileSync(join(saved, 'runtime.env'), 'utf8')).toBe(
      `AYVO_IMAGE_TAG=${tag}\nDEV_TAILNET_IPV4=127.0.0.1\n`,
    );
    // A partly failed switch removed the caddy altogether.
    run('docker', ['rm', '-f', `${project}-caddy-1`]);
    expect(get(port)).toBe('');
    const r = clean(helper, ['restore', saved, join(dir, 'fixture.env')]);
    expect(r.status, r.stderr).toBe(0);
    expect(until(port, 'tailnet')).toBe('tailnet');
  });
});

describe('deploy-dev.sh --edge switches nothing when the edge backup fails (TS33-R2)', () => {
  it('stops before any compose up', () => {
    const bin = join(dir, 'bin');
    run('mkdir', ['-p', bin, join(dir, 'state'), join(dir, 'bk')]);
    const log = join(dir, 'docker.log');
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const issuer = 'https://api.workos.com/user_management/client_FIXTURE0000000000000000';
    stub('curl', `cat >/dev/null; printf '{"issuer":"%s"}' "${issuer}"`);
    // A running caddy whose labels name no Compose file: the backup helper must fail.
    stub(
      'docker',
      `echo "$*" >>"${log}"
case "$1" in
  ps) echo cafe0001 ;;
  inspect) [[ "$*" == *Config.Image* && "$*" == *-api-1 ]] && echo ayvo-dev-preview/api:t1
           [[ "$*" == *Config.Image* && "$*" == *-web-1 ]] && echo ayvo-dev-preview/web:t1 ;;
esac
exit 0`,
    );
    stub(
      'tailscale',
      '[[ $1 == debug ]] && { echo \'{"NoSNAT":true}\'; exit 0; }; echo 100.100.100.1',
    );
    stub('ip', 'echo "5: tailscale0    inet 100.100.100.1/32 scope global tailscale0"');
    stub('systemctl', 'exit 0');
    stub('sysctl', 'echo 1');
    stub('dig', 'exit 0');
    const env = join(dir, 'deploy.env');
    writeFileSync(env, `APP_ENV=development\n${readFileSync(join(dir, 'fixture.env'), 'utf8')}`);
    chmodSync(env, 0o600);
    const r = run('bash', [join(root, 'scripts/deploy-dev.sh'), '--edge'], {
      PATH: `${bin}:${process.env.PATH}`,
      AYVO_DEV_ENV_FILE: env,
      AYVO_DEV_STATE_DIR: join(dir, 'state'),
      AYVO_DEV_BACKUP_DIR: join(dir, 'bk'),
    });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(output).toContain('the edge backup failed: nothing was changed');
    expect(output).not.toContain('fixture-password');
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/compose .*\bup\b/);
    expect(calls).not.toMatch(/\b(build|run|rm|stop|exec)\b/);
  });
});
