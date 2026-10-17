import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayvo-edge-'));
  writeFileSync(
    join(dir, 'fixture.env'),
    [
      'DEV_DOMAIN=dev.example-preview.test',
      'ACME_EMAIL=ops@ayvo.test',
      'DEV_BASIC_AUTH_USER=preview',
      `DEV_BASIC_AUTH_HASH='$2a$14$${'a'.repeat(53)}'`,
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

describe.skipIf(!hasDocker)('edge backup and restore (TS33-R2)', () => {
  const project = `ayvo-test-edge-${process.pid}`;
  const tag = 't1';
  const [oldPort, newPort] = [18000 + (process.pid % 1000), 19000 + (process.pid % 1000)];
  let work: string;
  let backups: string;

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
  const get = (port: number) =>
    run('curl', ['-s', '-m', '3', `http://127.0.0.1:${port}/`]).stdout.trim();
  const until = (port: number, body: string) => {
    for (let i = 0; i < 30 && get(port) !== body; i++) run('sleep', ['0.5']);
    return get(port);
  };

  beforeAll(() => {
    work = join(dir, 'work');
    backups = join(dir, 'backups');
    run('mkdir', ['-p', work]);
    run('docker', ['pull', '-q', 'alpine:3.20']);
    run('docker', ['tag', 'alpine:3.20', `ayvo-edgetest/api:${tag}`]);
    writeFileSync(join(work, 'compose.yml'), compose(oldPort));
    writeFileSync(join(work, 'Caddyfile'), ':80 {\n\trespond "old"\n}\n');
    chmodSync(join(work, 'Caddyfile'), 0o644);
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

  it('saves what Caddy really uses and restores it after a partly failed switch', () => {
    // The file on disk was already replaced (new inode): the backup must hold the RUNNING one.
    writeFileSync(join(work, 'Caddyfile.next'), ':80 {\n\trespond "disk"\n}\n');
    renameSync(join(work, 'Caddyfile.next'), join(work, 'Caddyfile'));

    const b = run(helper, ['backup', project, backups, join(dir, 'fixture.env')]);
    expect(b.status, b.stderr).toBe(0);
    const saved = b.stdout.trim();
    expect(existsSync(join(saved, 'COMPLETE'))).toBe(true);
    expect(readFileSync(join(saved, 'Caddyfile'), 'utf8')).toContain('respond "old"');
    expect(readFileSync(join(saved, 'tag'), 'utf8').trim()).toBe(tag);
    expect(readFileSync(join(saved, 'ports'), 'utf8').trim()).toBe(`127.0.0.1:${oldPort}->80/tcp`);

    // The switch: a new caddy on another port plus a dns service that fails to start.
    writeFileSync(
      join(work, 'compose.yml'),
      compose(newPort, "  dns:\n    image: alpine:3.20\n    command: ['false']\n"),
    );
    writeFileSync(join(work, 'Caddyfile'), ':80 {\n\trespond "new"\n}\n');
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
    const saved = b.stdout.trim();
    writeFileSync(join(saved, 'Caddyfile'), ':80 {\n\trespond "tampered"\n}\n');
    const r = run(helper, ['restore', saved, join(dir, 'fixture.env')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('checksums');
    expect(until(oldPort, 'old')).toBe('old');
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
    stub('tailscale', 'echo 100.100.100.1');
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
      AYVO_DEV_VERIFY_PASSWORD: 'fixture-password',
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
