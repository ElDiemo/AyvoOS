import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The production deployment (doc 036, ADR 0033): its Compose project, edge, host guard and deploy
 * script. No container is started: Compose only validates/renders the configuration with
 * fictional values, and the host guard runs against fake iptables/ip6tables that record their
 * arguments. The real proof from outside the tailnet is the owner's (doc 036 §5).
 */
const root = resolve(import.meta.dirname, '../../..');
const prodDir = join(root, 'deploy/prod');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const run = (cmd: string, args: string[], env: Record<string, string> = {}, cwd = root) =>
  spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
const hasCompose = run('docker', ['compose', 'version']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'ayvo-deploy-prod-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Without comment lines (comments may name what the configuration does NOT do). */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const compose = read('deploy/prod/compose.yml');
const caddyfile = read('deploy/prod/Caddyfile');
const corefile = read('deploy/prod/Corefile');
const script = read('scripts/deploy-prod.sh');

/** Environment keys of a service in compose.yml (plain YAML, read textually). */
function serviceBlock(service: string): string {
  return compose.split(new RegExp(`^  ${service}:\\n`, 'm'))[1]!.split(/^ {2}\S/m)[0]!;
}
function serviceEnv(service: string): Record<string, string> {
  const env = serviceBlock(service)
    .split(/^ {4}environment:\n/m)[1]!
    .split(/^ {4}\S/m)[0]!;
  return Object.fromEntries(
    [...env.matchAll(/^ {6}([A-Z0-9_]+): (.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

describe('production Compose project', () => {
  it('is its own project with its own images and volumes', () => {
    expect(compose).toMatch(/^name: ayvo-prod$/m);
    for (const s of ['web', 'api', 'migrate']) {
      expect(serviceBlock(s)).toMatch(/image: ayvo-prod\/(web|api|api-migrate):\$\{AYVO_RELEASE/);
    }
    const volumes = [...compose.matchAll(/^ {4}name: (\S+)$/gm)].map((m) => m[1]);
    expect(volumes.length).toBe(4);
    expect(volumes.every((v) => v!.startsWith('ayvo-prod-'))).toBe(true);
    expect(code(compose)).not.toMatch(/ayvo-dev/);
  });

  it('runs the whole application with APP_ENV=production, real sign-in and S3 — no test switches', () => {
    expect(serviceEnv('api').APP_ENV).toBe('production');
    expect(serviceEnv('web').APP_ENV).toBe('production');
    expect(serviceEnv('api')).toMatchObject({
      AUTH_PROVIDER: 'workos',
      WORKOS_CLIENT_ID: 'client_01M4R7SYY9BSQQCT0RHV4E468Q',
      WORKOS_JWT_ISSUER: 'https://api.workos.com/user_management/client_01M4R7SYY9BSQQCT0RHV4E468Q',
      APP_PUBLIC_ORIGIN: 'https://${PROD_DOMAIN:?set by scripts/deploy-prod.sh}',
      FILE_STORAGE_DRIVER: 's3',
      AWS_REGION: 'eu-north-1',
      S3_BUCKET: 'ayvo-prod-files-888725257303-eu-north-1-an',
      S3_EXPECTED_BUCKET_OWNER: "'888725257303'",
    });
    // QR / label values have no default: the owner sets the physically validated ones.
    for (const key of ['PUBLIC_QR_BASE_URL', 'LABEL_QR_MIN_SIZE_MM', 'LABEL_QR_ERROR_CORRECTION']) {
      expect(serviceEnv('api')[key]).toMatch(new RegExp(`^\\$\\{${key}:\\?`));
    }
    expect(compose).not.toMatch(
      /AUTH_PROVIDER: test|CARRIER_PROVIDER|PPL_TEST|APP_ENV: development/,
    );
    expect(compose).not.toMatch(/basic_?auth/i);
    // ADR 0014: the production QR host is never a value or default outside the QR policy.
    expect(compose).not.toContain('qr.ayvo.co');
    // The application gets its own S3 identity, never the backup identity.
    expect(serviceBlock('api')).toContain('/prod-s3.env');
    expect(compose).not.toContain('prod-s3-backup.env');
  });

  it('publishes only Caddy and DNS on the tailnet address, and IPv4 :80 for ACME', () => {
    const published = [...compose.matchAll(/^ {6}- '([^']+:\d+(?:\/(?:udp|tcp))?)'$/gm)].map(
      (m) => m[1],
    );
    expect(published).toEqual([
      '${PROD_TAILNET_IPV4:?set by scripts/deploy-prod.sh from tailscale ip -4}:443:443',
      '${PROD_TAILNET_IPV4}:443:443/udp',
      '0.0.0.0:80:80',
      '${PROD_TAILNET_IPV4}:53:1053/udp',
      '${PROD_TAILNET_IPV4}:53:1053/tcp',
    ]);
    for (const s of ['web', 'api', 'migrate', 'postgres', 'redis']) {
      expect(serviceBlock(s), s).not.toMatch(/^ {4}ports:/m);
    }
    expect(compose).toMatch(/ {2}backend:\n {4}internal: true/);
  });

  it('passes every placeholder of the Caddyfile and the Corefile to its container', () => {
    const placeholders = (text: string) => [
      ...new Set([...text.matchAll(/\{\$([A-Z0-9_]+)\}/g)].map((m) => m[1]!)),
    ];
    for (const key of placeholders(caddyfile)) expect(serviceEnv('caddy'), key).toHaveProperty(key);
    for (const key of placeholders(corefile)) expect(serviceEnv('dns'), key).toHaveProperty(key);
  });

  it.skipIf(!hasCompose)('validates with the env files and needs the owner-set values', () => {
    const secrets = join(tmp, 'secrets');
    run('mkdir', ['-p', secrets]);
    // Fictional values only.
    writeFileSync(
      join(secrets, 'prod.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
        'PUBLIC_QR_BASE_URL=https://qr.example.test\nLABEL_QR_MIN_SIZE_MM=15\nLABEL_QR_ERROR_CORRECTION=Q\n',
    );
    writeFileSync(join(secrets, 'prod-workos.env'), 'WORKOS_API_KEY=sk_test_fictional\n');
    writeFileSync(
      join(secrets, 'prod-s3.env'),
      'AWS_ACCESS_KEY_ID=AKIAFICTIONAL0000000\nAWS_SECRET_ACCESS_KEY=fictional\n',
    );
    const env = {
      PROD_DOMAIN: 'os.example.test',
      PROD_TAILNET_IPV4: '100.100.100.100',
      AYVO_RELEASE: 'abcdef012345',
      AYVO_RELEASE_DIR: root,
      AYVO_PROD_SECRETS_DIR: secrets,
    };
    const args = ['compose', '-p', 'ayvo-prod-test', '-f', join(prodDir, 'compose.yml')];
    const withEnv = [...args, '--env-file', join(secrets, 'prod.env')];
    expect(run('docker', [...withEnv, 'config', '--quiet'], env).status).toBe(0);
    const rendered = JSON.parse(
      run('docker', [...withEnv, 'config', '--format', 'json'], env).stdout,
    );
    expect(rendered.services.api.environment).toMatchObject({
      APP_ENV: 'production',
      WORKOS_API_KEY: 'sk_test_fictional',
      AWS_ACCESS_KEY_ID: 'AKIAFICTIONAL0000000',
      LABEL_QR_MIN_SIZE_MM: '15',
    });
    // Without the physically validated QR values the configuration does not even render.
    writeFileSync(
      join(secrets, 'incomplete.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n',
    );
    const res = run(
      'docker',
      [...args, '--env-file', join(secrets, 'incomplete.env'), 'config', '--quiet'],
      env,
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUBLIC_QR_BASE_URL|LABEL_QR/);
  });
});

describe('production edge (Caddy)', () => {
  it('admits only Tailscale peers — never the Docker gateway — and no Basic Auth', () => {
    expect([...code(caddyfile).matchAll(/remote_ip ([^\n]+)/g)].map((m) => m[1])).toEqual([
      '100.64.0.0/10',
    ]);
    expect(code(caddyfile)).not.toMatch(/172\.|192\.168\.|basic_?auth/i);
    expect(caddyfile).toMatch(/http:\/\/ \{\n\tabort\n\}/);
    // Public :80 sees nothing of the application (Caddy answers ACME before these routes).
    const http = caddyfile.split('http://{$PROD_DOMAIN} {')[1]!.split('\n}\n')[0]!;
    expect(http).toContain('handle @outside {\n\t\tabort');
    expect(http).not.toContain('reverse_proxy');
  });
});

describe('production host guard (DOCKER-USER, IPv4 and IPv6)', () => {
  /** Fake iptables / ip6tables / ip recording their calls; `ip` reports `route` as default. */
  function fakeBin(route: string) {
    const bin = mkdtempSync(join(tmp, 'bin-'));
    const log = join(bin, 'calls.log');
    for (const name of ['iptables', 'ip6tables']) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\necho "${name} $*" >> "${log}"\ncase "$1" in -S) exit 0;; esac\nexit 0\n`,
      );
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(
      join(bin, 'ip'),
      `#!/bin/sh\necho "default via 192.0.2.1 dev ${route} proto dhcp"\n`,
    );
    chmodSync(join(bin, 'ip'), 0o755);
    return { bin, log };
  }
  const guard = join(prodDir, 'host/ayvo-prod-docker-guard');

  it('drops new public connections to containers on IPv4 and IPv6; only IPv4 :80 passes', () => {
    const { bin, log } = fakeBin('eth0');
    const res = run('sh', [guard, 'apply'], { PATH: `${bin}:/usr/bin:/bin` });
    expect(res.status, res.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const family = (f: string) =>
      calls.filter((c) => c.startsWith(`${f} `)).map((c) => c.slice(f.length + 1));
    for (const f of ['iptables', 'ip6tables']) {
      expect(family(f), f).toEqual(
        expect.arrayContaining([
          '-N AYVO-PROD-GUARD',
          '-A AYVO-PROD-GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
          '-A AYVO-PROD-GUARD -j DROP',
          '-I DOCKER-USER 1 -i eth0 -j AYVO-PROD-GUARD',
        ]),
      );
      // DROP comes after the exceptions.
      const rules = family(f).filter((c) => c.startsWith('-A AYVO-PROD-GUARD'));
      expect(rules.at(-1), f).toBe('-A AYVO-PROD-GUARD -j DROP');
    }
    const port80 =
      '-A AYVO-PROD-GUARD -p tcp -m conntrack --ctstate DNAT --ctorigdstport 80 -j RETURN';
    expect(family('iptables')).toContain(port80);
    // IPv6: no exception at all.
    expect(family('ip6tables').filter((c) => c.includes('--ctorigdstport'))).toEqual([]);
  });

  it('refuses when the default route is the tailnet (exit node)', () => {
    const { bin } = fakeBin('tailscale0');
    const res = run('sh', [guard, 'apply'], { PATH: `${bin}:/usr/bin:/bin` });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/tailscale0/);
  });

  it('the installer checks shared subnet routes and overlaps before turning SNAT off; never UFW or SSH', () => {
    const install = read('deploy/prod/host/install.sh');
    const snat = install.indexOf('tailscale set --snat-subnet-routes=false');
    expect(snat).toBeGreaterThan(0);
    for (const check of ['AdvertiseRoutes', '100.64.0.0/10', 'iptables-save', 'ip6tables-save']) {
      expect(install.indexOf(check), check).toBeGreaterThan(0);
      expect(install.indexOf(check), check).toBeLessThan(snat);
    }
    expect(install).toContain('--check');
    for (const text of [install, read('deploy/prod/host/uninstall.sh')]) {
      expect(text).not.toMatch(/^\s*(ufw|systemctl\s+\S+\s+ssh)/m);
    }
  });
});

describe('production deploy script', () => {
  it('is valid bash', () => {
    expect(run('bash', ['-n', join(root, 'scripts/deploy-prod.sh')]).status).toBe(0);
  });

  it('never removes data, never prints the configuration, never sources an env file', () => {
    const body = code(script);
    expect(body).not.toMatch(/\bdown\b|volume rm|system prune|image prune|builder prune/);
    for (const m of body.matchAll(/compose config[^\n]*/g)) expect(m[0]).toContain('--quiet');
    expect(body).not.toMatch(/(^|\s)(source|\.)\s+"?\$SECRETS/m);
    expect(body).toContain('merge-base --is-ancestor "$RELEASE" origin/main');
    expect(body).toContain('git -C "$REPO_ROOT" archive');
  });

  it('backs up before migrating, and starts the new release only after migrating', () => {
    const main = script.slice(script.indexOf('  deploy)\n'));
    const order = [
      'build_images',
      'backup_before_migration',
      'migrate',
      'start_services',
      'verify',
    ];
    const at = order.map((step) => main.indexOf(`    ${step}\n`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  describe('env file checks (names only, an explicit list per file)', () => {
    /** Runs check_env_files of the real script on fictional files (its functions only). */
    function check(files: Record<string, string>, mode = 0o600) {
      const dir = mkdtempSync(join(tmp, 'secrets-'));
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
        chmodSync(join(dir, name), mode);
      }
      const lines = script.split('\n');
      const from = lines.findIndex((l) => l.startsWith('readonly SECRETS='));
      const to = lines.findIndex((l) => l.startsWith('# --- Compose'));
      const harness = `set -Eeuo pipefail\n${lines.slice(from, to).join('\n')}\nSTEP=test\ncheck_env_files\n`;
      return run('bash', ['-c', harness], { AYVO_PROD_SECRETS_DIR: dir, AYVO_PROD_DIR: dir });
    }
    const prod =
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
      'PUBLIC_QR_BASE_URL=https://qr.example.test\nLABEL_QR_MIN_SIZE_MM=15\nLABEL_QR_ERROR_CORRECTION=Q\n';
    const good = {
      'prod.env': prod,
      'prod-workos.env': '# WorkOS\nexport WORKOS_API_KEY="sk_test_fictional"\n',
      'prod-s3.env':
        'AWS_ACCESS_KEY_ID=AKIAAPPFICTIONAL0000\nAWS_SECRET_ACCESS_KEY=x\nAWS_REGION=eu-north-1\n',
      'prod-s3-backup.env': 'AWS_ACCESS_KEY_ID=AKIABACKUPFICTIONAL0\nAWS_SECRET_ACCESS_KEY=y\n',
    };

    it('accepts complete private files and prints no value', () => {
      const res = check(good);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout + res.stderr).not.toMatch(/fictional|AKIA/);
    });
    it.each([
      [
        'another key injected into the container',
        { 'prod-s3.env': `${good['prod-s3.env']}NODE_OPTIONS=--inspect\n` },
        /must not set NODE_OPTIONS/,
      ],
      [
        'an endpoint override',
        { 'prod-s3.env': `${good['prod-s3.env']}AWS_ENDPOINT_URL=https://x.test\n` },
        /must not set AWS_ENDPOINT_URL/,
      ],
      [
        'a test switch',
        { 'prod.env': `${prod}AUTH_PROVIDER=test\n` },
        /must not set AUTH_PROVIDER/,
      ],
      [
        'a bare key (filled from the environment)',
        { 'prod-workos.env': 'WORKOS_API_KEY\n' },
        /not KEY=VALUE/,
      ],
      [
        'an empty required value',
        { 'prod.env': prod.replace('LABEL_QR_MIN_SIZE_MM=15', 'LABEL_QR_MIN_SIZE_MM=') },
        /LABEL_QR_MIN_SIZE_MM is empty/,
      ],
      [
        'a missing physically validated value',
        { 'prod.env': prod.replace('LABEL_QR_ERROR_CORRECTION=Q\n', '') },
        /lacks LABEL_QR_ERROR_CORRECTION/,
      ],
      [
        'the backup identity given to the application',
        {
          'prod-s3-backup.env':
            "export AWS_ACCESS_KEY_ID='AKIAAPPFICTIONAL0000'\nAWS_SECRET_ACCESS_KEY=y\n",
        },
        /holds the backup identity/,
      ],
    ])('refuses %s', (_what, change, message) => {
      const res = check({ ...good, ...change });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(message);
      expect(res.stderr).not.toMatch(/fictional|AKIA/);
    });
    it('refuses files readable by others', () => {
      const res = check(good, 0o644);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/must not be readable by group or others/);
    });
  });

  it('exports the release with modes the non-root containers can read', () => {
    expect(script).toMatch(
      /umask 022[\s\S]*git -C "\$REPO_ROOT" archive[\s\S]*chmod -R a\+rX,go-w/,
    );
  });

  it.skipIf(!existsSync('/opt/ayvo/secrets/dev-preview.env'))(
    'refuses to run on the DEV server',
    () => {
      const res = run('bash', [join(root, 'scripts/deploy-prod.sh'), '--check', '--release', 'x'], {
        AYVO_PROD_DIR: join(tmp, 'prod'),
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/this is the DEV server|is not installed/);
    },
  );
});
