import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prodSecrets, renderProd } from './support/prod-compose.js';

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
const qrCaddyfile = read('deploy/prod/Caddyfile.qr');
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
    expect(volumes.length).toBe(6);
    expect(volumes.every((v) => v!.startsWith('ayvo-prod-'))).toBe(true);
    expect(code(compose)).not.toMatch(/ayvo-dev/);
  });

  it('runs the whole application with APP_ENV=production, real sign-in and S3 — no test switches', () => {
    expect(serviceEnv('api').APP_ENV).toBe('production');
    expect(serviceEnv('web').APP_ENV).toBe('production');
    expect(serviceEnv('api')).toMatchObject({
      AUTH_PROVIDER: 'local',
      APP_PUBLIC_ORIGIN: 'https://${PROD_DOMAIN:?set by scripts/deploy-prod.sh}',
      FILE_STORAGE_DRIVER: 's3',
      AWS_REGION: 'eu-north-1',
      S3_BUCKET: 'ayvo-prod-files-888725257303-eu-north-1-an',
      S3_EXPECTED_BUCKET_OWNER: "'888725257303'",
    });
    // The QR base URL is required; the physically validated QR label settings are optional and
    // have no default (empty = not set; ADR 0034) — never a value in this file.
    expect(serviceEnv('api').PUBLIC_QR_BASE_URL).toMatch(/^\$\{PUBLIC_QR_BASE_URL:\?/);
    for (const key of ['LABEL_QR_MIN_SIZE_MM', 'LABEL_QR_ERROR_CORRECTION']) {
      expect(serviceEnv('api')[key]).toBe(`\${${key}:-}`);
    }
    expect(compose).not.toMatch(
      /AUTH_PROVIDER: test|CARRIER_PROVIDER|PPL_TEST|APP_ENV: development/,
    );
    expect(compose).not.toMatch(/basic_?auth/i);
    // Native authentication: key and mail mode only from the private prod-auth.env, no WorkOS.
    expect(serviceBlock('api')).toContain('/prod-auth.env');
    expect(code(compose)).not.toMatch(/WORKOS|AUTH_MAIL_DRIVER:|AUTH_ENCRYPTION_KEY:|memory/);
    // ADR 0014: the production QR host is never a value or default outside the QR policy.
    expect(compose).not.toContain('qr.ayvo.co');
    // The application gets its own S3 identity, never the backup identity.
    expect(serviceBlock('api')).toContain('/prod-s3.env');
    expect(compose).not.toContain('prod-s3-backup.env');
  });

  it('publishes Caddy and DNS on the tailnet address, IPv4 :80 for ACME and the QR edge publicly', () => {
    const published = [...compose.matchAll(/^ {6}- '([^']+:\d+(?:\/(?:udp|tcp))?)'$/gm)].map(
      (m) => m[1],
    );
    expect(published).toEqual([
      '${PROD_TAILNET_IPV4:?set by scripts/deploy-prod.sh from tailscale ip -4}:443:443',
      '${PROD_TAILNET_IPV4}:443:443/udp',
      '0.0.0.0:80:80',
      '${PROD_PUBLIC_IPV4:?set by scripts/deploy-prod.sh from the public interface}:443:443/tcp',
      '${PROD_TAILNET_IPV4}:53:1053/udp',
      '${PROD_TAILNET_IPV4}:53:1053/tcp',
    ]);
    // The public QR edge reaches web only — never the API, the databases or the internal edge.
    const networks = (svc: string) =>
      [
        ...serviceBlock(svc)
          .split(/^ {4}networks:\n/m)[1]!
          .split(/^ {4}\S/m)[0]!
          .matchAll(/^ {6}- (\S+)$/gm),
      ].map((m) => m[1]);
    expect(networks('qr-edge')).toEqual(['public']);
    expect(networks('web')).toEqual(['edge', 'public']);
    for (const svc of ['api', 'postgres', 'redis', 'caddy', 'dns']) {
      expect(networks(svc), svc).not.toContain('public');
    }
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
    for (const key of placeholders(qrCaddyfile)) {
      expect(serviceEnv('qr-edge'), key).toHaveProperty(key);
    }
    for (const key of placeholders(corefile)) expect(serviceEnv('dns'), key).toHaveProperty(key);
  });

  it.skipIf(!hasCompose)('validates with the env files and needs the owner-set values', () => {
    const secrets = join(tmp, 'secrets');
    run('mkdir', ['-p', secrets]);
    // Fictional values only.
    writeFileSync(
      join(secrets, 'prod.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
        'PUBLIC_QR_BASE_URL=https://qr.example.test\nLABEL_QR_MIN_SIZE_MM=15\nLABEL_QR_ERROR_CORRECTION=Q\n',
    );
    writeFileSync(
      join(secrets, 'prod-auth.env'),
      `AUTH_ENCRYPTION_KEY=${'5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28'}\n` +
        'AUTH_MAIL_DRIVER=google-relay\nAUTH_MAIL_FROM=system@example.test\n',
    );
    writeFileSync(
      join(secrets, 'prod-s3.env'),
      'AWS_ACCESS_KEY_ID=AKIAFICTIONAL0000000\nAWS_SECRET_ACCESS_KEY=fictional\n',
    );
    const env = {
      PROD_DOMAIN: 'os.example.test',
      PROD_TAILNET_IPV4: '100.100.100.100',
      PROD_PUBLIC_IPV4: '198.51.100.7',
      QR_DOMAIN: 'qr.example.test',
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
      AUTH_MAIL_DRIVER: 'google-relay',
      AUTH_MAIL_FROM: 'system@example.test',
      AWS_ACCESS_KEY_ID: 'AKIAFICTIONAL0000000',
      LABEL_QR_MIN_SIZE_MM: '15',
    });
    // ADR 0041: the running core connects as `ayvo_core` and never receives the privileged
    // account's password; the migrate step (privileged) creates the role after the migrations.
    // (Values may come from the caller's environment, which Compose prefers — compared by parts.)
    const apiDb = new URL(rendered.services.api.environment.DATABASE_URL);
    const tools = JSON.parse(
      run('docker', [...withEnv, '--profile', 'tools', 'config', '--format', 'json'], env).stdout,
    );
    const migrateDb = new URL(tools.services.migrate.environment.DATABASE_URL);
    expect([apiDb.username, apiDb.password]).toEqual(['ayvo_core', 'c'.repeat(32)]);
    expect(migrateDb.username).not.toBe('ayvo_core');
    expect(migrateDb.password).not.toBe(apiDb.password);
    expect(JSON.stringify(rendered.services.api)).not.toContain(`:${migrateDb.password}@`);
    expect(tools.services.migrate.environment.CORE_DB_PASSWORD).toBe('c'.repeat(32));
    expect(tools.services.migrate.command.join(' ')).toMatch(
      /prisma migrate deploy && node dist\/database\/core-db-setup\.js$/,
    );
    // Without the core role's password the configuration does not render.
    writeFileSync(
      join(secrets, 'no-core.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
        'PUBLIC_QR_BASE_URL=https://qr.example.test\n',
    );
    const noCore = run(
      'docker',
      [...args, '--env-file', join(secrets, 'no-core.env'), 'config', '--quiet'],
      env,
    );
    expect(noCore.status).not.toBe(0);
    expect(noCore.stderr).toMatch(/CORE_DB_PASSWORD/);
    // Without the physically validated QR values it renders them empty (not set, ADR 0034).
    writeFileSync(
      join(secrets, 'no-qr-settings.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
        'PUBLIC_QR_BASE_URL=https://qr.example.test\n',
    );
    const noQr = JSON.parse(
      run(
        'docker',
        [...args, '--env-file', join(secrets, 'no-qr-settings.env'), 'config', '--format', 'json'],
        env,
      ).stdout,
    );
    expect(noQr.services.api.environment).toMatchObject({
      LABEL_QR_MIN_SIZE_MM: '',
      LABEL_QR_ERROR_CORRECTION: '',
    });
    // The QR base URL stays required: without it the configuration does not render.
    writeFileSync(
      join(secrets, 'incomplete.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n',
    );
    const res = run(
      'docker',
      [...args, '--env-file', join(secrets, 'incomplete.env'), 'config', '--quiet'],
      env,
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/PUBLIC_QR_BASE_URL/);
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

describe('public QR edge (Caddyfile.qr, doc 037)', () => {
  const qr = code(qrCaddyfile);
  it('serves only GET /<token> (rewritten to /q/<token>) and the static files; everything else 404', () => {
    expect([...qr.matchAll(/^\{\$[A-Z_]+\} \{$/gm)].map((m) => m[0])).toEqual(['{$QR_DOMAIN} {']);
    expect(qr).toContain('path_regexp token ^/([A-Za-z0-9_-]{22})$');
    expect(qr).toContain('rewrite * /q/{re.token.1}?');
    expect(qr).toMatch(
      /@static \{\n\t\tmethod GET HEAD\n\t\tpath \/_next\/static\/\* \/icon\.svg\n\t\}/,
    );
    expect(qr).toMatch(/\thandle \{\n\t\trespond "Not found" 404\n\t\}/);
    // Only web, never the API; no internal host, no sign-in, no tailnet rule needed here.
    expect([...qr.matchAll(/reverse_proxy (\S+)/g)].map((m) => m[1])).toEqual(['web:3000']);
    expect(qr).not.toMatch(/api:4000|PROD_DOMAIN|os\.ayvo|qr\.ayvo|basic_?auth|remote_ip/i);
    expect(qr).toContain('strict_sni_host on');
    expect(qr).toContain('disable_http_challenge');
  });
  it('strips what the internet must not send to the application', () => {
    for (const h of [
      'Cookie',
      'Authorization',
      'Next-Action',
      'Rsc',
      'Next-Router-State-Tree',
      'X-Ayvo-Path',
    ]) {
      expect(qr).toContain(`header_up -${h}`);
    }
    expect(qr).toContain('header_up X-Forwarded-For {remote_host}');
    expect(qr).toContain('header_down -Set-Cookie');
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
      `#!/bin/sh\ncase "$*" in *addr*) echo "2: ${route}    inet 198.51.100.7/32 scope global ${route}";;\n` +
        `*) echo "default via 192.0.2.1 dev ${route} proto dhcp";; esac\n`,
    );
    chmodSync(join(bin, 'ip'), 0o755);
    return { bin, log };
  }
  const guard = join(prodDir, 'host/ayvo-prod-docker-guard');

  it('drops new public connections to containers on IPv4 and IPv6; only IPv4 :80 and the QR edge pass', () => {
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
    // The public QR edge: only the public address's :443, new connections limited per source.
    const qr =
      '-A AYVO-PROD-GUARD -p tcp -m conntrack --ctstate DNAT --ctorigdst 198.51.100.7 --ctorigdstport 443';
    const v4 = family('iptables').filter((c) => c.startsWith('-A AYVO-PROD-GUARD'));
    expect(v4).toEqual([
      '-A AYVO-PROD-GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
      port80,
      `${qr} -m hashlimit --hashlimit-mode srcip --hashlimit-above 20/second --hashlimit-burst 60 --hashlimit-name ayvo-prod-qr -j DROP`,
      `${qr} -j RETURN`,
      '-A AYVO-PROD-GUARD -j DROP',
    ]);
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

describe('the production host scripts refuse a wrong host before any change (PROD51-R1)', () => {
  const MUTATING = ['install', 'systemctl', 'rm', 'cp', 'mkdir', 'chmod', 'sysctl', 'mv', 'ln'];
  const devTraces = [
    '/opt/ayvo/secrets/dev-preview.env',
    '/usr/local/sbin/ayvo-dev-docker-guard',
    '/etc/systemd/system/ayvo-dev-docker-guard.service',
    '/etc/sysctl.d/60-ayvo-dev-tailnet.conf',
  ].some((f) => existsSync(f));

  /** A simulated host: every command that could change something only records its call. */
  function simulate(host: {
    name: string;
    containers: string[];
    tailnet: string;
    docker?: boolean;
  }) {
    const bin = mkdtempSync(join(tmp, 'host-'));
    const log = join(bin, 'mutations.log');
    writeFileSync(log, '');
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake('id', 'case "$1" in -u) echo 0;; *) exit 0;; esac');
    fake('hostname', `echo ${host.name}`);
    fake(
      'docker',
      host.docker === false
        ? 'exit 1'
        : `[ "$1" = ps ] && printf '${host.containers.join('\\n')}\\n'; exit 0`,
    );
    // tailscale: the address; `set` would change something.
    fake(
      'tailscale',
      `case "$1" in ip) echo ${host.tailnet};; set) echo "tailscale $*" >> "${log}";; debug) echo '{"AdvertiseRoutes":null,"NoSNAT":false}';; esac`,
    );
    for (const name of MUTATING) fake(name, `echo "${name} $*" >> "${log}"`);
    return {
      bin,
      run: (script: string) => run('bash', [join(root, script)], { PATH: `${bin}:/usr/bin:/bin` }),
      mutations: () => readFileSync(log, 'utf8').trim(),
    };
  }
  const scripts = ['deploy/prod/host/install.sh', 'deploy/prod/host/uninstall.sh'];

  it('the DEV server (hostname, containers, address) changes nothing', () => {
    const host = simulate({
      name: 'AyvoOS',
      containers: ['ayvo-dev-preview-api-1', 'ayvo-dev-preview-caddy-1'],
      tailnet: '100.64.12.34',
    });
    for (const script of scripts) {
      const res = host.run(script);
      expect(res.status, `${script}: ${res.stdout}${res.stderr}`).toBe(1);
      expect(res.stderr).toContain('refusing');
      expect(host.mutations(), script).toBe('');
    }
  });

  it.each([
    [['ayvo-dev-preview-api-1'], '100.88.139.2', true, 'DEV preview containers'],
    [[], '100.64.12.34', true, "Tailscale IPv4 is '100.64.12.34'"],
    [[], '100.88.139.2', false, 'cannot list the containers'],
  ])(
    'the right name with %j / %s / docker %s changes nothing',
    (containers, tailnet, docker, message) => {
      const host = simulate({ name: 'AyvoOS-PROD', containers, tailnet, docker });
      for (const script of scripts) {
        const res = host.run(script);
        expect(res.status, script).toBe(1);
        // On the DEV server itself its real traces are found first.
        expect(res.stderr).toContain(devTraces ? 'DEV preview found' : message);
        expect(host.mutations(), script).toBe('');
      }
    },
  );

  it.each([
    ['--check', '--release', 'a'.repeat(40)],
    ['--release', 'a'.repeat(40)],
    ['--rollback', 'a'.repeat(12)],
  ])('deploy-prod.sh %s on the DEV server writes nothing — no directory, no log', (...args) => {
    const host = simulate({
      name: 'AyvoOS',
      containers: ['ayvo-dev-preview-api-1'],
      tailnet: '100.64.12.34',
    });
    // Every command the script requires exists (as a harmless fake) — the host check decides.
    for (const name of [
      'git',
      'curl',
      'jq',
      'flock',
      'tar',
      'sha256sum',
      'stat',
      'ip',
      'df',
      'getent',
      'runuser',
    ]) {
      writeFileSync(join(host.bin, name), '#!/bin/sh\nexit 0\n');
      chmodSync(join(host.bin, name), 0o755);
    }
    const prodDir = join(tmp, `prod-${args[0]!.slice(2)}`);
    const res = run('bash', [join(root, 'scripts/deploy-prod.sh'), ...args], {
      PATH: `${host.bin}:/usr/bin:/bin`,
      AYVO_PROD_DIR: prodDir,
      AYVO_PROD_SECRETS_DIR: join(tmp, 'no-secrets'),
    });
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/refusing: this host is 'AyvoOS'|DEV preview found/);
    expect(existsSync(prodDir), 'AYVO_PROD_DIR was created').toBe(false);
    expect(host.mutations()).toBe('');
  });

  it.skipIf(devTraces)(
    'the production host passes the check (then the fakes record changes)',
    () => {
      const host = simulate({
        name: 'AyvoOS-PROD',
        containers: ['ayvo-prod-api-1'],
        tailnet: '100.88.139.2',
      });
      host.run('deploy/prod/host/uninstall.sh');
      expect(host.mutations()).toContain('systemctl');
    },
  );
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
    expect(body).toContain('repo_git archive');
  });

  it('the OS deployment never builds, starts or stops the marketing site; --marketing touches only it', () => {
    const fn = (name: string) => {
      const i = script.indexOf(`${name}() {`);
      return script.slice(i, script.indexOf('\n}\n', i));
    };
    expect(fn('start_services')).not.toContain('marketing');
    expect(fn('build_images')).not.toContain('marketing');
    const marketing = script.slice(
      script.indexOf('  marketing)\n'),
      script.indexOf('  marketing-rollback)\n'),
    );
    // The image accepted on DEV is loaded and its identity checked before anything starts; the
    // marketing site is never built on production.
    for (const flag of ['--expect-image', '--expect-digest', '--image-archive'])
      expect(marketing).toContain(flag);
    const order = [
      'load_marketing_image',
      'check_release',
      'start_marketing',
      'verify_marketing_release',
    ];
    const at = order.map((step) => marketing.indexOf(step));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(marketing).not.toMatch(
      /build_images|compose build|migrate|start_services|backup_before_migration/,
    );
    expect(fn('start_marketing')).toContain('compose up -d --no-build --no-deps marketing');
    expect(fn('start_marketing')).toContain('running_marketing_digest');
    // Marketing images are not removed with old OS releases.
    expect(fn('remove_old_images')).toContain('(api|api-migrate|web)');
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

  it.skipIf(!hasCompose)('the public ID edge exists only with compose.id.yml and ID_DOMAIN', () => {
    const secrets = join(tmp, 'secrets-id');
    run('mkdir', ['-p', secrets]);
    writeFileSync(
      join(secrets, 'prod.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
        'PUBLIC_QR_BASE_URL=https://qr.example.test\n',
    );
    for (const f of ['prod-auth.env', 'prod-s3.env']) writeFileSync(join(secrets, f), 'X=1\n');
    const env = {
      PROD_DOMAIN: 'os.example.test',
      PROD_TAILNET_IPV4: '100.100.100.100',
      PROD_PUBLIC_IPV4: '198.51.100.7',
      QR_DOMAIN: 'qr.example.test',
      AYVO_RELEASE: 'abcdef012345',
      AYVO_RELEASE_DIR: root,
      AYVO_PROD_SECRETS_DIR: secrets,
    };
    const base = ['compose', '-p', 'ayvo-prod-test', '--env-file', join(secrets, 'prod.env')];
    const render = (files: string[], extra: Record<string, string> = {}) =>
      run(
        'docker',
        [...base, ...files.flatMap((f) => ['-f', join(prodDir, f)]), 'config', '--format', 'json'],
        {
          ...env,
          ...extra,
        },
      );
    const off = JSON.parse(render(['compose.yml']).stdout);
    // Disabled = today: no acme network, default commands, no ID_DOMAIN, the same ports.
    expect(Object.keys(off.networks)).not.toContain('acme');
    for (const s of ['caddy', 'qr-edge']) {
      expect(off.services[s].command ?? null, s).toBeNull();
      expect(off.services[s].environment.ID_DOMAIN, s).toBeUndefined();
    }
    const on = JSON.parse(
      render(['compose.yml', 'compose.id.yml'], { ID_DOMAIN: 'id.example.test' }).stdout,
    );
    const withAcme = Object.entries(on.services as Record<string, { networks?: object }>)
      .filter(([, svc]) => Object.keys(svc.networks ?? {}).includes('acme'))
      .map(([name]) => name)
      .sort();
    expect(withAcme).toEqual(['caddy', 'qr-edge']);
    expect(Object.keys(on.services['qr-edge'].networks).sort()).toEqual(['acme', 'public']);
    expect(Object.keys(on.services.caddy.networks).sort()).toEqual(['acme', 'edge']);
    // No new published port: qr-edge keeps only public :443, caddy its tailnet/ACME ports.
    const ports = (cfg: { services: Record<string, { ports?: unknown[] }> }, s: string) =>
      JSON.stringify(cfg.services[s]?.ports ?? []);
    expect(ports(on, 'qr-edge')).toBe(ports(off, 'qr-edge'));
    expect(ports(on, 'caddy')).toBe(ports(off, 'caddy'));
    expect(on.services['qr-edge'].command).toEqual([
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile.id',
      '--adapter',
      'caddyfile',
    ]);
    expect(on.services.caddy.command).toEqual([
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile.acme',
      '--adapter',
      'caddyfile',
    ]);
    expect(on.services['qr-edge'].environment.ID_DOMAIN).toBe('id.example.test');
    // The API, web and databases are untouched by the ID edge.
    for (const s of ['api', 'web', 'postgres', 'redis']) {
      expect(JSON.stringify(on.services[s]), s).toBe(JSON.stringify(off.services[s]));
    }
    // The override never renders without ID_DOMAIN.
    const missing = render(['compose.yml', 'compose.id.yml']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/ID_DOMAIN/);
  });

  describe('env file checks (names only, an explicit list per file)', () => {
    /** Runs check_env_files of the real script on fictional files (its functions only). */
    /**
     * Runs the env file checks. `owner` is the approved owner (default: the user running the
     * tests, who owns the files); `asRoot` simulates `sudo` (only `id -u` without a user answers 0).
     */
    function check(
      files: Record<string, string>,
      mode = 0o600,
      opts: { owner?: string; asRoot?: boolean; call?: string } = {},
    ) {
      const dir = mkdtempSync(join(tmp, 'secrets-'));
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
        chmodSync(join(dir, name), mode);
      }
      const lines = script.split('\n');
      const from = lines.findIndex((l) => l.startsWith('readonly SECRETS='));
      const to = lines.findIndex((l) => l.startsWith('# --- Compose'));
      const root = opts.asRoot
        ? 'id() { if [[ $# == 1 && $1 == -u ]]; then echo 0; else command id "$@"; fi; }\n'
        : '';
      const harness = `set -Eeuo pipefail\n${root}${lines.slice(from, to).join('\n')}\nSTEP=test\n${opts.call ?? 'check_env_files'}\n`;
      return run('bash', ['-c', harness], {
        AYVO_PROD_SECRETS_DIR: dir,
        AYVO_PROD_DIR: dir,
        AYVO_PROD_OWNER: opts.owner ?? userInfo().username,
      });
    }
    const prod =
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
      'PUBLIC_QR_BASE_URL=https://qr.example.test\nLABEL_QR_MIN_SIZE_MM=15\nLABEL_QR_ERROR_CORRECTION=Q\n';
    const good = {
      'prod.env': prod,
      'prod-auth.env':
        '# native authentication\nAUTH_ENCRYPTION_KEY=5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28\n' +
        'AUTH_MAIL_DRIVER=google-relay\nAUTH_MAIL_FROM=system@example.test\n',
      'prod-s3.env':
        'AWS_ACCESS_KEY_ID=AKIAAPPFICTIONAL0000\nAWS_SECRET_ACCESS_KEY=x\nAWS_REGION=eu-north-1\n',
      'prod-s3-backup.env': 'AWS_ACCESS_KEY_ID=AKIABACKUPFICTIONAL0\nAWS_SECRET_ACCESS_KEY=y\n',
    };

    it('Finance keys (ADR 0039): none = not installed; all four with a matching SHA and its own S3 identity; nothing printed', () => {
      const token = 'f'.repeat(43);
      const sha = '0b1ab6d4f4e1f7d0a32a8c1c1b2d6c2a39b53e1f2c8b2e7d6c5a4b3c2d1e0f9a'; // not the real SHA
      const realSha = spawnSync(
        'sh',
        ['-c', `printf '%s' '${token}' | sha256sum | cut -d' ' -f1`],
        {
          encoding: 'utf8',
        },
      ).stdout.trim();
      const fin = (over: Record<string, string> = {}) =>
        Object.entries({
          FINANCE_DB_PASSWORD: 'r'.repeat(32),
          FINANCE_DB_OWNER_PASSWORD: 'o'.repeat(32),
          FINANCE_SERVICE_TOKEN: token,
          FINANCE_SERVICE_TOKEN_SHA256: realSha,
          ...over,
        })
          .filter(([, v]) => v !== '')
          .map(([k, v]) => `${k}=${v}\n`)
          .join('');
      const finS3 = 'AWS_ACCESS_KEY_ID=AKIAFINANCEFICTIONAL\nAWS_SECRET_ACCESS_KEY=z\n';
      const withFin = (over: Record<string, string> = {}, s3 = finS3) => ({
        ...good,
        'prod.env': prod + fin(over),
        'prod-finance-s3.env': s3,
      });
      const none = check(good, 0o600, { call: 'check_env_files; echo "FIN=$FINANCE_ENABLED"' });
      expect(none.status, none.stderr).toBe(0);
      expect(none.stdout).toContain('Finance keys not set');
      expect(none.stdout).toContain('FIN=false');
      const ok = check(withFin(), 0o600, { call: 'check_env_files; echo "FIN=$FINANCE_ENABLED"' });
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('FIN=true');
      for (const [why, files, msg] of [
        [
          'only some keys',
          withFin({ FINANCE_SERVICE_TOKEN: '', FINANCE_SERVICE_TOKEN_SHA256: '' }),
          /all of/,
        ],
        ['wrong SHA', withFin({ FINANCE_SERVICE_TOKEN_SHA256: sha }), /not the SHA-256/],
        ['short password', withFin({ FINANCE_DB_PASSWORD: 'short' }), /24-128/],
        [
          'equal role passwords',
          withFin({ FINANCE_DB_OWNER_PASSWORD: 'r'.repeat(32) }),
          /must differ/,
        ],
        [
          'the core role password',
          withFin({ FINANCE_DB_PASSWORD: 'c'.repeat(32) }),
          /CORE_DB_PASSWORD/,
        ],
        ['bad token', withFin({ FINANCE_SERVICE_TOKEN: 'x y' }), /base64url/],
        [
          'the application S3 identity',
          withFin({}, 'AWS_ACCESS_KEY_ID=AKIAAPPFICTIONAL0000\nAWS_SECRET_ACCESS_KEY=x\n'),
          /application's S3 identity/,
        ],
        [
          'the backup identity',
          withFin({}, 'AWS_ACCESS_KEY_ID=AKIABACKUPFICTIONAL0\nAWS_SECRET_ACCESS_KEY=x\n'),
          /backup identity/,
        ],
        [
          'no Finance S3 file',
          { ...good, 'prod.env': prod + fin() },
          /prod-finance-s3.env does not exist/,
        ],
        [
          'a foreign key in it',
          withFin({}, `${finS3}AWS_ENDPOINT_URL=http://evil\n`),
          /must not set AWS_ENDPOINT_URL/,
        ],
      ] as const) {
        const res = check(files as Record<string, string>);
        expect([why, res.status]).toEqual([why, 1]);
        expect(res.stderr, why).toMatch(msg);
        // Values are never printed.
        for (const secret of ['r'.repeat(32), 'o'.repeat(32), token])
          expect(res.stdout + res.stderr, why).not.toContain(secret);
      }
    });

    it('accepts an optional ID_DOMAIN in prod.env', () => {
      const res = check({ ...good, 'prod.env': `${prod}ID_DOMAIN=id.example.test\n` });
      expect(res.status, res.stderr).toBe(0);
    });
    it('id_domain: unset = no ID edge; a plain other host name only', () => {
      const call = (value: string | null) =>
        check(
          { ...good, 'prod.env': value === null ? prod : `${prod}ID_DOMAIN=${value}\n` },
          0o600,
          {
            call: 'DOMAIN=os.example.test; QR_DOMAIN=qr.example.test; id_domain; echo "ID=[$ID_DOMAIN]"',
          },
        );
      expect(call(null).stdout).toContain('ID=[]');
      expect(call('id.example.test').stdout).toContain('ID=[id.example.test]');
      for (const bad of [
        'https://id.example.test',
        'id',
        'ID.example.test',
        'qr.example.test',
        'os.example.test',
        'id.example.test/x',
      ]) {
        const res = call(bad);
        expect([bad, res.status]).toEqual([bad, 1]);
      }
    });
    it('compose_files: the ID override only with ID_DOMAIN and only if the release has it', () => {
      const rel = mkdtempSync(join(tmp, 'release-'));
      run('mkdir', ['-p', join(rel, 'deploy/prod')]);
      writeFileSync(join(rel, 'deploy/prod/compose.yml'), '');
      const lines = script.split('\n');
      const start = lines.findIndex((l) => l.startsWith('compose_files() {'));
      const fn = lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
      const files = (id: string) =>
        check(good, 0o600, {
          call: `${fn}\nID_DOMAIN=${id}; compose_files ${rel} | tr '\\n' ' '`,
        }).stdout.trim();
      expect(files('')).toBe(`-f ${rel}/deploy/prod/compose.yml`);
      expect(files('id.example.test')).toBe(`-f ${rel}/deploy/prod/compose.yml`); // older release
      writeFileSync(join(rel, 'deploy/prod/compose.id.yml'), '');
      expect(files('')).toBe(`-f ${rel}/deploy/prod/compose.yml`);
      expect(files('id.example.test')).toBe(
        `-f ${rel}/deploy/prod/compose.yml -f ${rel}/deploy/prod/compose.id.yml`,
      );
    });
    it('marketing_domain: unset = no marketing site; the apex, never www or another host', () => {
      const call = (value: string | null, id = '') =>
        check(
          { ...good, 'prod.env': value === null ? prod : `${prod}MARKETING_DOMAIN=${value}\n` },
          0o600,
          {
            call: `DOMAIN=os.example.test; QR_DOMAIN=qr.example.test; ID_DOMAIN=${id}; marketing_domain; echo "M=[$MARKETING_DOMAIN]"`,
          },
        );
      expect(call(null).stdout).toContain('M=[]');
      expect(call('ayvo.example.test', 'id.example.test').stdout).toContain(
        'M=[ayvo.example.test]',
      );
      for (const [bad, id] of [
        ['https://ayvo.example.test', ''],
        ['www.ayvo.example.test', ''],
        ['ayvo', ''],
        ['qr.example.test', ''],
        ['os.example.test', ''],
        ['id.example.test', 'id.example.test'],
        ['example.test', 'www.example.test'],
      ] as const) {
        const res = call(bad, id);
        expect([bad, res.status]).toEqual([bad, 1]);
      }
    });
    it('compose_files: the marketing override only with MARKETING_DOMAIN and only if the release has it', () => {
      const rel = mkdtempSync(join(tmp, 'release-m-'));
      run('mkdir', ['-p', join(rel, 'deploy/prod')]);
      writeFileSync(join(rel, 'deploy/prod/compose.yml'), '');
      writeFileSync(join(rel, 'deploy/prod/compose.id.yml'), '');
      const lines = script.split('\n');
      const start = lines.findIndex((l) => l.startsWith('compose_files() {'));
      const fn = lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
      const files = (m: string) =>
        check(good, 0o600, {
          call: `${fn}\nID_DOMAIN=id.example.test; MARKETING_DOMAIN=${m}; compose_files ${rel} | tr '\\n' ' '`,
        }).stdout.trim();
      const base = `-f ${rel}/deploy/prod/compose.yml -f ${rel}/deploy/prod/compose.id.yml`;
      expect(files('ayvo.example.test')).toBe(base); // older release without the override
      writeFileSync(join(rel, 'deploy/prod/compose.marketing.yml'), '');
      expect(files('')).toBe(base);
      expect(files('ayvo.example.test')).toBe(
        `${base} -f ${rel}/deploy/prod/compose.marketing.yml`,
      );
    });
    it('accepts complete private files and prints no value', () => {
      const res = check(good);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout + res.stderr).not.toMatch(/fictional|AKIA/);
    });
    it('accepts no QR label settings at all: the application starts without them (ADR 0034)', () => {
      const res = check({
        ...good,
        'prod.env': prod.replace('LABEL_QR_MIN_SIZE_MM=15\nLABEL_QR_ERROR_CORRECTION=Q\n', ''),
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/QR label settings not set/);
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
        { 'prod-auth.env': 'AUTH_ENCRYPTION_KEY\n' },
        /not KEY=VALUE/,
      ],
      [
        'the relay together with SMTP credentials',
        { 'prod-auth.env': `${good['prod-auth.env']}AUTH_SMTP_PASSWORD=fictional\n` },
        /google-relay uses no SMTP host or credentials/,
      ],
      [
        'password SMTP without its password',
        {
          'prod-auth.env': good['prod-auth.env']
            .replace('google-relay', 'smtp')
            .concat('AUTH_SMTP_HOST=smtp.example.test\nAUTH_SMTP_USER=u\n'),
        },
        /needs AUTH_SMTP_HOST, AUTH_SMTP_USER and AUTH_SMTP_PASSWORD/,
      ],
      [
        'the memory test mail driver',
        { 'prod-auth.env': good['prod-auth.env'].replace('google-relay', 'memory') },
        /must be smtp or google-relay/,
      ],
      [
        'a test encryption key',
        {
          'prod-auth.env': good['prod-auth.env'].replace(
            /AUTH_ENCRYPTION_KEY=\w+/,
            `AUTH_ENCRYPTION_KEY=${'1'.repeat(64)}`,
          ),
        },
        /is not random/,
      ],
      [
        'an old WorkOS key in the authentication file',
        { 'prod-auth.env': `${good['prod-auth.env']}WORKOS_API_KEY=fictional\n` },
        /must not set WORKOS_API_KEY/,
      ],
      [
        'an empty required value',
        { 'prod.env': prod.replace('ACME_EMAIL=ops@example.test', 'ACME_EMAIL=') },
        /ACME_EMAIL is empty/,
      ],
      [
        'only one of the two QR label settings',
        { 'prod.env': prod.replace('LABEL_QR_ERROR_CORRECTION=Q\n', '') },
        /sets only LABEL_QR_MIN_SIZE_MM: set both/,
      ],
      [
        'one QR label setting empty',
        { 'prod.env': prod.replace('LABEL_QR_MIN_SIZE_MM=15', 'LABEL_QR_MIN_SIZE_MM=') },
        /sets only LABEL_QR_ERROR_CORRECTION: set both/,
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
    it('PROD51-R2: with sudo (root) it accepts the approved owner ayvo:600, not only root', () => {
      const res = check(good, 0o600, { asRoot: true });
      expect(res.status, res.stderr).toBe(0);
    });
    it('PROD51-R2: with sudo a foreign owner and unsafe modes stay refused', () => {
      // The files belong to the test user; the approved owner is someone else.
      const foreign = check(good, 0o600, { asRoot: true, owner: 'nobody' });
      expect(foreign.status).toBe(1);
      expect(foreign.stderr).toMatch(/must belong to nobody or root/);
      const open = check(good, 0o640, { asRoot: true });
      expect(open.status).toBe(1);
      expect(open.stderr).toMatch(/must not be readable by group or others/);
    });
    it('runs only as root (sudo) or as the approved owner', () => {
      expect(check(good, 0o600, { call: 'check_runner' }).status).toBe(0);
      expect(
        check(good, 0o600, { asRoot: true, owner: 'nobody', call: 'check_runner' }).status,
      ).toBe(0);
      const other = check(good, 0o600, { owner: 'nobody', call: 'check_runner' });
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/run as root \(sudo\) or as nobody/);
    });
    it('git runs as the approved owner under sudo — never safe.directory or relaxed host keys', () => {
      const bin = mkdtempSync(join(tmp, 'bin-'));
      writeFileSync(join(bin, 'runuser'), '#!/bin/sh\necho "runuser $*"\n');
      chmodSync(join(bin, 'runuser'), 0o755);
      const res = run(
        'bash',
        [
          '-c',
          `id() { if [[ $# == 1 && $1 == -u ]]; then echo 0; else command id "$@"; fi; }\n` +
            `REPO_ROOT=/opt/ayvo/repos/AyvoOS\nDEPLOY_OWNER=ayvo\n` +
            script
              .split('\n')
              .slice(
                script.split('\n').findIndex((l) => l.startsWith('repo_git() {')),
                script.split('\n').findIndex((l) => l.startsWith('check_checkout() {')),
              )
              .join('\n') +
            '\nrepo_git fetch --quiet origin main\n',
        ],
        { PATH: `${bin}:/usr/bin:/bin` },
      );
      expect(res.stdout).toMatch(
        /^runuser -u ayvo -- env HOME=\S* git -C \/opt\/ayvo\/repos\/AyvoOS fetch --quiet origin main$/m,
      );
      expect(code(script)).not.toMatch(/safe\.directory|StrictHostKeyChecking|UserKnownHostsFile/);
      expect(code(script)).not.toMatch(/^\s*git -C "\$REPO_ROOT" (fetch|archive|show|cat-file)/m);
    });
    it('refuses files readable by others', () => {
      const res = check(good, 0o644);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/must not be readable by group or others/);
    });
  });

  it('exports the release with modes the non-root containers can read', () => {
    expect(script).toMatch(/umask 022[\s\S]*repo_git archive[\s\S]*chmod -R a\+rX,go-w/);
  });

  it.skipIf(!existsSync('/opt/ayvo/secrets/dev-preview.env'))(
    'refuses to run on the DEV server',
    () => {
      const res = run('bash', [join(root, 'scripts/deploy-prod.sh'), '--check', '--release', 'x'], {
        AYVO_PROD_DIR: join(tmp, 'prod'),
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/refusing: this host is|DEV preview|is not installed/);
    },
  );
});

describe('the Finance unit in production (ADR 0039)', () => {
  it('Caddy aborts the internal contract and routes /api/admin/finance to Finance — both before /api', () => {
    const app = code(caddyfile).split('handle @outside {')[1]!;
    const internal = app.indexOf('@internal path /api/internal /api/internal/*');
    const finance = app.indexOf('@finance path /api/admin/finance /api/admin/finance/*');
    const api = app.indexOf('@api path /api /api/*');
    expect(internal).toBeGreaterThan(0);
    expect(finance).toBeGreaterThan(internal);
    expect(api).toBeGreaterThan(finance);
    expect(app).toMatch(/handle @internal \{\n\t\t\tabort\n\t\t\}/);
    expect(app).toMatch(/handle @finance \{\n\t\t\treverse_proxy finance:4010/);
  });

  it('Finance is the release api image, never built, in its own profile; the migrations in theirs', () => {
    const finance = serviceBlock('finance');
    expect(finance).toContain('image: ${FINANCE_IMAGE:-ayvo-prod/api:none}');
    expect(finance).not.toMatch(/^ {4}build:/m);
    expect(finance).toMatch(/profiles:\n {6}- finance\n/);
    expect(finance).not.toMatch(/^ {4}ports:/m);
    expect(finance).toContain("command: ['node', 'dist/finance/main.js']");
    expect(finance).toMatch(/read_only: true/);
    expect(finance).toMatch(/mem_limit: 512m/);
    const migrate = serviceBlock('finance-migrate');
    expect(migrate).toContain('image: ${FINANCE_MIGRATE_IMAGE:-ayvo-prod/api-migrate:none}');
    expect(migrate).toMatch(/profiles:\n {6}- finance-tools\n/);
    expect(serviceEnv('finance')).toMatchObject({
      APP_ENV: 'production',
      FILE_STORAGE_DRIVER: 's3',
      CORE_INTERNAL_URL: 'http://api:4000',
    });
    expect(serviceEnv('web')).toMatchObject({ FINANCE_API_URL: 'http://finance:4010' });
    // The API gets the token's SHA-256 only, never the token.
    expect(serviceEnv('api')).toHaveProperty('FINANCE_SERVICE_TOKEN_SHA256');
    expect(serviceEnv('api')).not.toHaveProperty('FINANCE_SERVICE_TOKEN');
  });

  it.skipIf(!hasCompose)(
    'renders: finance-db only between Finance, its migrations and postgres; its own S3 file and DB roles',
    () => {
      const secrets = mkdtempSync(join(tmp, 'fin-secrets-'));
      writeFileSync(
        join(secrets, 'prod.env'),
        'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
          `PUBLIC_QR_BASE_URL=https://qr.example.test\nFINANCE_DB_PASSWORD=${'r'.repeat(32)}\nFINANCE_DB_OWNER_PASSWORD=${'o'.repeat(32)}\n` +
          `FINANCE_SERVICE_TOKEN=${'f'.repeat(43)}\nFINANCE_SERVICE_TOKEN_SHA256=${'a'.repeat(64)}\n`,
      );
      writeFileSync(
        join(secrets, 'prod-auth.env'),
        'AUTH_ENCRYPTION_KEY=x\nAUTH_MAIL_DRIVER=google-relay\nAUTH_MAIL_FROM=s@example.test\n',
      );
      writeFileSync(
        join(secrets, 'prod-s3.env'),
        'AWS_ACCESS_KEY_ID=AKIAAPP\nAWS_SECRET_ACCESS_KEY=a\n',
      );
      writeFileSync(
        join(secrets, 'prod-finance-s3.env'),
        'AWS_ACCESS_KEY_ID=AKIAFIN\nAWS_SECRET_ACCESS_KEY=f\n',
      );
      const env = {
        PROD_DOMAIN: 'os.example.test',
        PROD_TAILNET_IPV4: '100.100.100.100',
        PROD_PUBLIC_IPV4: '198.51.100.7',
        QR_DOMAIN: 'qr.example.test',
        AYVO_RELEASE: 'abcdef012345',
        FINANCE_IMAGE: `sha256:${'1'.repeat(64)}`,
        FINANCE_MIGRATE_IMAGE: `sha256:${'2'.repeat(64)}`,
        AYVO_RELEASE_DIR: root,
        AYVO_PROD_SECRETS_DIR: secrets,
      };
      const args = [
        'compose',
        '-p',
        'ayvo-prod-test',
        '-f',
        join(prodDir, 'compose.yml'),
        '--env-file',
        join(secrets, 'prod.env'),
      ];
      const render = (...profiles: string[]) =>
        JSON.parse(
          run(
            'docker',
            [...args, ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'],
            env,
          ).stdout,
        );
      // The OS alone renders without Finance services.
      expect(Object.keys(render().services)).not.toContain('finance');
      const all = render('finance', 'finance-tools', 'tools');
      const nets = (s: string) => Object.keys(all.services[s].networks ?? {}).sort();
      expect(nets('finance')).toEqual(['edge', 'finance-db']);
      expect(nets('finance-migrate')).toEqual(['finance-db']);
      expect(nets('postgres')).toEqual(['backend', 'finance-db']);
      for (const other of ['api', 'web', 'redis', 'caddy', 'migrate'])
        expect(nets(other), other).not.toContain('finance-db');
      expect(all.networks['finance-db'].internal).toBe(true);
      expect(all.services.finance.image).toBe(`sha256:${'1'.repeat(64)}`);
      expect(all.services['finance-migrate'].image).toBe(`sha256:${'2'.repeat(64)}`);
      expect(all.services.finance.environment.AWS_ACCESS_KEY_ID).toBe('AKIAFIN');
      expect(all.services.api.environment.AWS_ACCESS_KEY_ID).toBe('AKIAAPP');
      const db = new URL(all.services.finance.environment.FINANCE_DATABASE_URL);
      expect([db.username, db.password]).toEqual(['ayvo_finance', 'r'.repeat(32)]);
      const owner = new URL(
        all.services['finance-migrate'].environment.FINANCE_MIGRATE_DATABASE_URL,
      );
      expect(owner.username).toBe('ayvo_finance_owner');
      expect(JSON.stringify(all.services.finance)).not.toContain('fictional'); // no privileged password
      expect(JSON.stringify(all.services.api)).not.toContain('f'.repeat(43)); // no service token
      expect(all.services.api.environment.FINANCE_SERVICE_TOKEN_SHA256).toBe('a'.repeat(64));
    },
  );

  it('the script: Finance only from the release the OS runs, its own profiles, no build, a backup before migrating', () => {
    const body = script.split('\n  finance)\n')[1]!.split('\n    ;;\n')[0]!;
    expect(body).toMatch(/\$\{RELEASE:0:12\} == "\$PREVIOUS"/);
    const order = [
      'pin_finance_images',
      'check_core_holds_finance_contract',
      'backup_before_migration',
      'migrate_finance',
      'start_finance',
      'verify_finance',
      'record_finance',
    ];
    const at = order.map((step) => body.indexOf(step));
    expect(
      at.every((i) => i > 0),
      JSON.stringify(at),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).not.toMatch(/build_images|compose build/);
    expect(script).toContain('compose --profile finance-tools run --rm finance-migrate');
    expect(script).toContain('compose --profile finance up -d --no-build --no-deps finance');
    const rollback = script.split('\n  finance-rollback)\n')[1]!.split('\n    ;;\n')[0]!;
    expect(rollback).not.toMatch(/migrate_finance|backup_before_migration/);
    // The OS deployment never starts Finance (its profile is never activated there).
    const deploy = script.split('\n  deploy)\n')[1]!.split('\n    ;;\n')[0]!;
    expect(deploy).not.toMatch(/finance/i);
  });

  /** The source of one function of the script (from `name() {` to its closing brace). */
  const fnSrc = (name: string) => {
    const i = script.indexOf(`\n${name}() {`);
    expect(i, name).toBeGreaterThan(0);
    return script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
  };
  const HELPERS = [
    'set -Eeuo pipefail',
    'log() { echo "LOG $*"; }',
    'ok() { echo "OK $*"; }',
    'warn() { echo "WARN $*"; }',
    'die() { echo "DIE $*"; exit 1; }',
    'PROJECT=ayvo-prod; IMAGE_PREFIX=ayvo-prod',
  ].join('\n');
  const id = (c: string) => `sha256:${c.repeat(64)}`;
  /**
   * A docker double: `inspect --format … <container>` answers RUN_API / RUN_FIN; `image inspect
   * [--format …] <ref>` looks the ref (a tag, or an ID as its own ref) up in the IMAGES table
   * ("<ref> <id>" per line); `image rm` is recorded in REMOVED; `image ls` lists the tags.
   */
  const DOCKER = [
    'docker() {',
    '  local last=${!#}',
    '  case "$1 $2" in',
    '    "inspect --format")',
    '      case $last in',
    '        *-api-1) [[ -n ${RUN_API:-} ]] && echo "$RUN_API" || return 1 ;;',
    '        *-finance-1 | c-finance) [[ -n ${RUN_FIN:-} ]] && echo "$RUN_FIN" || return 1 ;;',
    '        *) return 1 ;;',
    '      esac ;;',
    '    "image inspect")',
    '      local hit',
    '      hit="$(awk -v r="$last" \'$1 == r { print $2 }\' "$IMAGES")"',
    '      if [[ -z $hit ]] && awk -v r="$last" \'$2 == r { f = 1 } END { exit !f }\' "$IMAGES"; then hit=$last; fi',
    '      [[ -n $hit ]] || return 1',
    '      [[ $3 == --format ]] && echo "$hit"',
    '      return 0 ;;',
    '    "image ls") awk \'$1 ~ /:/ { print $1 }\' "$IMAGES" ;;',
    '    "image rm") echo "$3" >>"$REMOVED" ;;',
    '    "ps -a") echo "${PS_NAMES:-}" ;;',
    '    "ps -aq") [[ -n ${RUN_FIN:-} ]] && echo c-finance || true ;;',
    '    *) echo "unexpected docker $*" >&2; return 1 ;;',
    '  esac',
    '}',
  ].join('\n');
  const harness = (body: string, env: Record<string, string>) =>
    spawnSync('bash', ['-c', `${HELPERS}\n${DOCKER}\n${body}`], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  it('PROD78-R1: Finance is pinned to the image ID the API runs; a moved tag or another running image stops before any change', () => {
    const dir = mkdtempSync(join(tmp, 'pin-'));
    run('mkdir', ['-p', join(dir, 'state/images')]);
    const images = join(dir, 'images.txt');
    // Release abcdef012345 was built as api=1…, api-migrate=2…; its tag now points at 9….
    writeFileSync(
      join(dir, 'state/images/abcdef012345'),
      `api ${id('1')}\napi-migrate ${id('2')}\nweb ${id('3')}\n`,
    );
    writeFileSync(images, `ayvo-prod/api:abcdef012345 ${id('9')}\nx ${id('1')}\nx ${id('2')}\n`);
    const pin = (env: Record<string, string>, release = 'abcdef012345') =>
      harness(
        `PROD_DIR=${dir}; AYVO_RELEASE=${release}\n${fnSrc('pin_finance_images')}\npin_finance_images\necho "IMG=$FINANCE_IMAGE MIG=$FINANCE_MIGRATE_IMAGE"\necho AFTER-PIN`,
        { IMAGES: images, ...env },
      );
    // The API runs what the release was built as: pinned to those IDs; the moved tag is ignored.
    const okRun = pin({ RUN_API: id('1') });
    expect(okRun.status, okRun.stdout + okRun.stderr).toBe(0);
    expect(okRun.stdout).toContain(`IMG=${id('1')} MIG=${id('2')}`);
    // The API runs another image (an interrupted re-deploy re-tagged the revision) or none.
    for (const [why, env] of [
      ['another running image', { RUN_API: id('9') }],
      ['no API running', {}],
    ] as const) {
      const res = pin(env);
      expect([why, res.status]).toEqual([why, 1]);
      expect(res.stdout).toContain('DIE');
      expect(res.stdout).not.toContain('AFTER-PIN');
    }
    // No record for the release (deployed by an older script): refused.
    expect(pin({ RUN_API: id('1') }, '000000000000').stdout).toMatch(
      /DIE no image IDs are recorded/,
    );
    // The release's migration image is gone: refused too.
    writeFileSync(images, `x ${id('1')}\n`);
    expect(pin({ RUN_API: id('1') }).stdout).toMatch(/DIE the migration image/);
    // The finance case pins before its first change (the backup), never by tag.
    const body = script.split('\n  finance)\n')[1]!.split('\n    ;;\n')[0]!;
    expect(body.indexOf('pin_finance_images')).toBeGreaterThan(0);
    expect(body.indexOf('pin_finance_images')).toBeLessThan(
      body.indexOf('backup_before_migration'),
    );
    expect(body).not.toContain('image inspect "$IMAGE_PREFIX/api:');
  });

  it('PROD78-R1: after starting, the finance container must run exactly the pinned image ID', () => {
    const start = (running: string) =>
      harness(
        `compose() { :; }\nwait_healthy() { :; }\nFINANCE_RELEASE=abcdef012345; FINANCE_IMAGE=${id('1')}\n${fnSrc('start_finance')}\nstart_finance\necho STARTED`,
        { RUN_FIN: running, IMAGES: '/dev/null' },
      );
    expect(start(id('1')).stdout).toContain('STARTED');
    const other = start(id('9'));
    expect(other.status).toBe(1);
    expect(other.stdout).toMatch(/DIE the finance container runs/);
  });

  it("PROD78-R2: cleanup keeps the running and the previous verified Finance release (images and exports) on Finance's own history", () => {
    const dir = mkdtempSync(join(tmp, 'retention-'));
    run('mkdir', ['-p', join(dir, 'state')]);
    const images = join(dir, 'images.txt');
    const removed = join(dir, 'removed.txt');
    writeFileSync(removed, '');
    const rel = (x: string) => x.padEnd(12, '0');
    // OS history c1…c4 (the newest 3 kept); Finance history fe, fa, fb (fb runs, fa before it).
    const [c1, c2, c3, c4, fe, fa, fb] = ['c1', 'c2', 'c3', 'c4', 'fe', 'fa', 'fb'].map(rel) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    writeFileSync(
      join(dir, 'state/releases.log'),
      [c1, c2, c3, c4].map((r) => `${r}0000 t`).join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'state/finance.log'),
      `${fe} ${id('e')} ${id('e')} t\n${fa} ${id('a')} ${id('a')} t\n${fb} ${id('b')} ${id('b')} t\n`,
    );
    const ids: Record<string, string> = { [fe]: id('e'), [fa]: id('a'), [fb]: id('b') };
    const all = [c1, c2, c3, c4, fe, fa, fb];
    writeFileSync(
      images,
      all
        .flatMap((r, i) =>
          ['api', 'api-migrate'].map((s) => `ayvo-prod/${s}:${r} ${ids[r] ?? id(String(i + 1))}`),
        )
        .join('\n') + '\n',
    );
    for (const r of all) run('mkdir', ['-p', join(dir, 'releases', r)]);
    const res = harness(
      `PROD_DIR=${dir}; KEEP_RELEASES=3; KEEP_FINANCE_RELEASES=2; PREVIOUS=${c3}\n${fnSrc('current_finance')}\n${fnSrc('remove_old_images')}\nremove_old_images`,
      { IMAGES: images, REMOVED: removed, RUN_FIN: id('b'), PS_NAMES: `ayvo-prod/web:${c4}` },
    );
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readFileSync(removed, 'utf8').trim().split('\n').sort()).toEqual(
      [
        `ayvo-prod/api:${c1}`,
        `ayvo-prod/api-migrate:${c1}`,
        `ayvo-prod/api:${fe}`,
        `ayvo-prod/api-migrate:${fe}`,
      ].sort(),
    );
    for (const keep of [fa, fb, c2, c3, c4])
      expect(existsSync(join(dir, 'releases', keep)), keep).toBe(true);
    for (const old of [c1, fe]) expect(existsSync(join(dir, 'releases', old)), old).toBe(false);
  });
});

describe('the Finance deployment flow keeps the OS running (incident 2026-10-26)', () => {
  /** The source of one function of the script (from `name() {` to its closing brace). */
  const fnSrc = (name: string) => {
    const i = script.indexOf(`\n${name}() {`);
    expect(i, name).toBeGreaterThan(0);
    return script.slice(i + 1, script.indexOf('\n}\n', i) + 2);
  };
  /** The literal body of the `finance)` case of the script. */
  const financeCase = () => script.split('\n  finance)\n')[1]!.split('\n    ;;\n')[0]!;
  /**
   * A Compose double with state: which services run (files in $STATE/run), every step appended to
   * $STATE/steps. Finance is ready only while the API runs (it asks the core for every user).
   */
  const DOUBLES = [
    'running() { [[ -f $STATE/run/$1 ]]; }',
    'step() { echo "$*" >>"$STATE/steps"; }',
    'compose() {',
    '  local args=("$@")',
    '  case "$*" in',
    '    "ps -q "*) local s; for s in "${args[@]:2}"; do running "$s" && echo "id-$s"; done; return 0 ;;',
    '    "stop "*) local s; for s in "${args[@]:1}"; do rm -f "$STATE/run/$s"; step "STOP $s"; done ;;',
    '    *"exec -T postgres sh -c"*"count(*)"*) echo 5 ;;',
    '    *"exec -T postgres sh -c"*pg_dump*)',
    '      step "DUMP api=$(running api && echo up || echo down) web=$(running web && echo up || echo down) finance=$(running finance && echo up || echo down)"',
    '      echo dump ;;',
    '    *"exec -T postgres pg_restore --list"*) cat >/dev/null ;;',
    '    "--profile finance-tools run --rm finance-migrate")',
    '      step MIGRATE; [[ -z ${FAIL_MIGRATE:-} ]] ;;',
    '    "--profile finance up -d --no-build --no-deps finance") touch "$STATE/run/finance"; step "START finance" ;;',
    '    "exec -T -e WANT=none finance node -e "*) step "RB none"; return 0 ;;',
    '    "exec -T finance node -e "*)',
    '      step "READY? api=$(running api && echo up || echo down)"',
    '      running api && running finance ;;',
    '    *) echo "unexpected compose $*" >&2; return 1 ;;',
    '  esac',
    '}',
    'wait_healthy() { running "$1"; }',
    'docker() { [[ "$1 $2" == "inspect --format" ]] && running finance && echo "$FINANCE_IMAGE"; }',
    'edge_status() {',
    '  case "$*" in',
    '    *"/api/admin/finance/"*) running api && running finance && echo 401 || echo 502 ;;',
    '    *"/api/internal/"*) echo 000; return 1 ;;',
    '  esac',
    '}',
    's3_backup_as_owner() { step "S3 $1"; }',
    'check_release() { :; }',
    'validate_compose() { :; }',
    'check_core_holds_finance_contract() { step "CONTRACT api=$(running api && echo up || echo down)"; }',
    'backup_status() { :; }',
    'pin_finance_images() { FINANCE_IMAGE=sha256:$(printf 1%.0s {1..64}); FINANCE_MIGRATE_IMAGE=$FINANCE_IMAGE; }',
  ].join('\n');
  const flow = (opts: { financeRunning: boolean; failMigrate?: boolean }) => {
    const state = mkdtempSync(join(tmp, 'flow-'));
    run('mkdir', ['-p', join(state, 'run'), join(state, 'prod/state'), join(state, 'backup-tool')]);
    for (const s of ['api', 'web', ...(opts.financeRunning ? ['finance'] : [])])
      writeFileSync(join(state, 'run', s), '');
    const body = [
      'set -Eeuo pipefail',
      'log() { echo "LOG $*"; }',
      'ok() { echo "OK $*"; }',
      'warn() { echo "WARN $*"; }',
      'die() { echo "DIE $*"; exit 1; }',
      DOUBLES,
      ...[
        'backup_before_migration',
        'migrate_finance',
        'start_finance',
        'verify_finance',
        'record_finance',
        'verify_rb_premium',
      ].map(fnSrc),
      `PROJECT=ayvo-prod; IMAGE_PREFIX=ayvo-prod; DOMAIN=os.example.test; PROD_DIR=${state}/prod`,
      `RELEASE=${'a'.repeat(40)}; PREVIOUS=${'a'.repeat(12)}; FINANCE_ENABLED=true; MIGRATED=false`,
      `FINANCE_RELEASE=${opts.financeRunning ? 'b'.repeat(12) : ''}`,
      // The backup tool directory is looked up by its absolute path: point the check at a test one.
      financeCase().replace(/\/usr\/local\/lib\/ayvo-backup/g, `${state}/backup-tool`),
    ].join('\n');
    const res = spawnSync(
      'bash',
      ['-c', body.replace(/\/usr\/local\/lib\/ayvo-backup/g, `${state}/backup-tool`)],
      {
        encoding: 'utf8',
        env: { ...process.env, STATE: state, FAIL_MIGRATE: opts.failMigrate ? '1' : '' },
      },
    );
    const steps = readFileSync(join(state, 'steps'), 'utf8').trim().split('\n');
    const running = ['api', 'web', 'finance'].filter((s) => existsSync(join(state, 'run', s)));
    const log = existsSync(join(state, 'prod/state/finance.log'))
      ? readFileSync(join(state, 'prod/state/finance.log'), 'utf8')
      : '';
    return { res, steps, running, log };
  };

  it('first installation: api and web are never stopped; backup → migrate → start → ready with the OS up; recorded', () => {
    const { res, steps, running, log } = flow({ financeRunning: false });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(steps.filter((s) => s.startsWith('STOP'))).toEqual([]);
    const at = (prefix: string) => steps.findIndex((s) => s.startsWith(prefix));
    expect(steps[at('DUMP')]).toBe('DUMP api=up web=up finance=down');
    expect(at('DUMP')).toBeLessThan(at('MIGRATE'));
    expect(at('MIGRATE')).toBeLessThan(at('START finance'));
    expect(at('START finance')).toBeLessThan(at('READY?'));
    expect(steps[at('READY?')]).toBe('READY? api=up');
    expect(running).toEqual(['api', 'web', 'finance']);
    expect(log).toMatch(new RegExp(`^${'a'.repeat(12)} sha256:1{64} sha256:1{64} `));
  });

  it('upgrade: only the old Finance is stopped before the dump; the OS keeps running throughout; recorded', () => {
    const { res, steps, running, log } = flow({ financeRunning: true });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(steps.filter((s) => s.startsWith('STOP'))).toEqual(['STOP finance']);
    const at = (prefix: string) => steps.findIndex((s) => s.startsWith(prefix));
    expect(at('STOP finance')).toBeLessThan(at('DUMP'));
    expect(steps[at('DUMP')]).toBe('DUMP api=up web=up finance=down');
    expect(at('DUMP')).toBeLessThan(at('MIGRATE'));
    expect(steps[at('READY?')]).toBe('READY? api=up');
    expect(running).toEqual(['api', 'web', 'finance']);
    expect(log).not.toBe('');
  });

  it('a failed Finance migration records nothing and leaves the OS running', () => {
    const { res, steps, running, log } = flow({ financeRunning: true, failMigrate: true });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('DIE the Finance setup or migration failed');
    expect(steps).not.toContain('START finance');
    expect(log).toBe('');
    expect(running).toEqual(['api', 'web']);
  });

  it('the OS deployment still stops its own writers (web and api) before its backup', () => {
    const deploy = script.split('\n  deploy)\n')[1]!.split('\n    ;;\n')[0]!;
    expect(deploy).toContain('\n    backup_before_migration\n');
    expect(fnSrc('backup_before_migration')).toContain('local writers=${1:-web api}');
    expect(financeCase()).toContain('backup_before_migration finance "finance-$AYVO_RELEASE"');
  });
});

describe('optional bank connection from RB Premium API (doc 036 §10a)', () => {
  const lines = script.split('\n');
  const checks = lines
    .slice(
      lines.findIndex((l) => l.startsWith('readonly SECRETS=')),
      lines.findIndex((l) => l.startsWith('# --- Compose')),
    )
    .join('\n');
  const SECRET = 'NEVER-PRINTED-VALUE';
  const FILES = ['certificate.p12', 'client-id', 'p12-passphrase'];
  /** A secrets directory as the owner prepares it; options break one thing at a time. */
  const secretsDir = (
    o: {
      accounts?: string;
      dirMode?: number;
      fileMode?: number;
      extra?: boolean;
      missing?: string;
      empty?: string;
      link?: string;
    } = {},
  ) => {
    const dir = mkdtempSync(join(tmp, 'rb-'));
    writeFileSync(
      join(dir, 'prod.env'),
      o.accounts === undefined ? 'POSTGRES_DB=x\n' : `RB_PREMIUM_ACCOUNTS=${o.accounts}\n`,
    );
    const rb = join(dir, 'rb-premium');
    run('mkdir', [rb]);
    for (const f of FILES) {
      if (f === o.missing) continue;
      if (f === o.link) {
        writeFileSync(join(dir, 'elsewhere'), SECRET);
        run('ln', ['-s', join(dir, 'elsewhere'), join(rb, f)]);
        continue;
      }
      writeFileSync(join(rb, f), f === o.empty ? '' : SECRET);
      chmodSync(join(rb, f), o.fileMode ?? 0o400);
    }
    if (o.extra) writeFileSync(join(rb, 'copy.p12'), SECRET);
    chmodSync(rb, o.dirMode ?? 0o500);
    return dir;
  };
  const checkRb = (dir: string, o: { finance?: boolean; uid?: number } = {}) => {
    const res = run(
      'bash',
      [
        '-c',
        `set -Eeuo pipefail\nFINANCE_UID=${o.uid ?? userInfo().uid}\n${checks}\nSTEP=test\nFINANCE_ENABLED=${o.finance ?? true}\ncheck_rb_premium\necho "ACCOUNTS=$RB_PREMIUM_ACCOUNTS"`,
      ],
      { AYVO_PROD_SECRETS_DIR: dir, AYVO_PROD_DIR: dir, AYVO_PROD_OWNER: userInfo().username },
    );
    chmodSync(join(dir, 'rb-premium'), 0o700); // so the temporary directory can be removed
    return res;
  };

  it('off by default: nothing is required, nothing is enabled', () => {
    const res = checkRb(secretsDir(), { finance: false });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('RB_PREMIUM_ACCOUNTS not set');
    expect(res.stdout).toContain('ACCOUNTS=\n');
  });

  it('on: the accounts and the three owner-only files pass; no file content is ever printed', () => {
    const res = checkRb(secretsDir({ accounts: '1234567890:CZK,123:EUR' }));
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('bank connection: 2 account(s)');
    expect(res.stdout).toContain('ACCOUNTS=1234567890:CZK,123:EUR');
    expect(res.stdout + res.stderr).not.toContain(SECRET);
  });

  it.each([
    ['without the Finance keys', {}, { finance: false }, /without the Finance keys/],
    ['an account with a prefix', { accounts: '19-2000145399:CZK' }, {}, /number:CUR/],
    ['an 11-digit account', { accounts: '12345678901:CZK' }, {}, /number:CUR/],
    ['a lower-case currency', { accounts: '123:czk' }, {}, /number:CUR/],
    ['a directory readable by others', { dirMode: 0o750 }, {}, /owner only/],
    ['a file readable by the group', { fileMode: 0o440 }, {}, /readable by its owner only/],
    ['another file in the directory', { extra: true }, {}, /exactly certificate\.p12/],
    ['a missing passphrase', { missing: 'p12-passphrase' }, {}, /exactly certificate\.p12/],
    ['an empty client ID', { empty: 'client-id' }, {}, /client-id is empty/],
    ['a symbolic link', { link: 'certificate.p12' }, {}, /must be a regular file/],
    ['files of another user', {}, { uid: userInfo().uid + 1 }, /must belong to uid/],
  ])('refuses %s', (_why, dirOpts, checkOpts, message) => {
    const res = checkRb(secretsDir({ accounts: '1234567890:CZK', ...dirOpts }), checkOpts);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(message);
    expect(res.stdout + res.stderr).not.toContain(SECRET);
  });

  it('prod.env may hold RB_PREMIUM_ACCOUNTS; the env example holds no value', () => {
    expect(script).toMatch(/readonly ALLOW_PROD="[^"]* RB_PREMIUM_ACCOUNTS"/);
    expect(read('deploy/prod/prod.env.example')).toMatch(/^# RB_PREMIUM_ACCOUNTS=$/m);
  });

  it('compose_files: the override only with RB_PREMIUM_ACCOUNTS and only if the release has it', () => {
    const rel = mkdtempSync(join(tmp, 'release-rb-'));
    run('mkdir', ['-p', join(rel, 'deploy/prod')]);
    writeFileSync(join(rel, 'deploy/prod/compose.yml'), '');
    const start = lines.findIndex((l) => l.startsWith('compose_files() {'));
    const fn = lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
    const files = (accounts: string) =>
      run('bash', [
        '-c',
        `${fn}\nRB_PREMIUM_ACCOUNTS=${accounts}; compose_files ${rel} | tr '\\n' ' '`,
      ]).stdout.trim();
    const base = `-f ${rel}/deploy/prod/compose.yml`;
    expect(files('1234567890:CZK')).toBe(base); // a release without the override
    writeFileSync(join(rel, 'deploy/prod/compose.rb-premium.yml'), '');
    expect(files('')).toBe(base); // off: exactly as before
    expect(files('1234567890:CZK')).toBe(`${base} -f ${rel}/deploy/prod/compose.rb-premium.yml`);
  });

  it('the override holds only paths and the accounts variable — no value of a secret', () => {
    const override = code(read('deploy/prod/compose.rb-premium.yml'));
    expect(override).toMatch(/^ {2}finance:$/m);
    expect([...override.matchAll(/^ {2}(\S+):$/gm)].map((m) => m[1])).toEqual(['finance']);
    expect(
      [...override.matchAll(/^ {6}(RB_[A-Z0-9_]+): (.*)$/gm)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ['RB_PREMIUM_ENVIRONMENT', 'production'],
      ['RB_PREMIUM_CLIENT_ID_FILE', '/run/secrets/rb-premium/client-id'],
      ['RB_PREMIUM_P12_FILE', '/run/secrets/rb-premium/certificate.p12'],
      ['RB_PREMIUM_P12_PASSPHRASE_FILE', '/run/secrets/rb-premium/p12-passphrase'],
      [
        'RB_PREMIUM_ACCOUNTS',
        '${RB_PREMIUM_ACCOUNTS:?set in prod.env (number:CUR, comma-separated)}',
      ],
    ]);
    expect(override).not.toMatch(/FOR_TESTS|sandbox|BASE_URL/);
    expect(code(compose)).not.toMatch(/RB_PREMIUM|rb-premium/);
  });

  it.skipIf(!hasCompose)(
    'renders: on, only Finance gains the read-only mount and the connection; off, nothing changes',
    () => {
      const off = prodSecrets();
      const on = prodSecrets('RB_PREMIUM_ACCOUNTS=1234567890:CZK\n');
      const profiles = ['finance', 'finance-tools', 'tools'];
      const before = renderProd(off, { profiles }).config!;
      const after = renderProd(on, { overrides: ['compose.rb-premium.yml'], profiles }).config!;
      for (const s of Object.keys(before.services).filter((n) => n !== 'finance'))
        expect(after.services[s], s).toEqual(before.services[s]);
      const { environment: envOn, volumes, ...restOn } = after.services.finance!;
      const { environment: envOff, ...restOff } = before.services.finance!;
      expect(restOn).toEqual(restOff);
      expect(before.services.finance!.volumes).toBeUndefined();
      expect(volumes).toHaveLength(1);
      const { bind, ...mount } = volumes![0]!;
      expect(mount).toEqual({
        type: 'bind',
        source: join(on, 'rb-premium'),
        target: '/run/secrets/rb-premium',
        read_only: true,
      });
      // Never created by Docker when absent. Compose versions render the false value differently
      // (v5.6 here: `create_host_path: false`; the CI runner's omits it: `bind: {}`).
      expect(bind?.create_host_path ?? false).toBe(false);
      const added = Object.fromEntries(
        Object.entries(envOn!).filter(([k]) => !(k in envOff!) || envOff![k] !== envOn![k]),
      );
      expect(added).toEqual({
        RB_PREMIUM_ENVIRONMENT: 'production',
        RB_PREMIUM_CLIENT_ID_FILE: '/run/secrets/rb-premium/client-id',
        RB_PREMIUM_P12_FILE: '/run/secrets/rb-premium/certificate.p12',
        RB_PREMIUM_P12_PASSPHRASE_FILE: '/run/secrets/rb-premium/p12-passphrase',
        RB_PREMIUM_ACCOUNTS: '1234567890:CZK',
      });
      // The override without the accounts in prod.env does not render at all.
      const missing = renderProd(off, { overrides: ['compose.rb-premium.yml'], profiles });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('RB_PREMIUM_ACCOUNTS');
    },
  );

  /** The container check of verify_rb_premium, run by node against a temporary directory. */
  const containerCheck = (dir: string, env: Record<string, string>) => {
    const fn = script.split('\nverify_rb_premium() {\n')[1]!.split('\n}\n')[0]!;
    const js = fn.split("node -e '")[1]!.split("' ||")[0]!;
    return spawnSync('node', ['-e', js.replaceAll('/run/secrets/rb-premium', dir)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    }).status;
  };
  it('the container check: production with readable files on a read-only directory; off means no connection and no mount', () => {
    const base = mkdtempSync(join(tmp, 'rb-container-'));
    const dir = join(base, 'rb-premium');
    run('mkdir', [dir]);
    for (const f of FILES) writeFileSync(join(dir, f), SECRET);
    const prodEnv = {
      WANT: 'production',
      RB_PREMIUM_ENVIRONMENT: 'production',
      RB_PREMIUM_P12_FILE: `${dir}/certificate.p12`,
    };
    chmodSync(dir, 0o500);
    try {
      expect(containerCheck(dir, prodEnv)).toBe(0);
      expect(containerCheck(dir, { ...prodEnv, RB_PREMIUM_ENVIRONMENT: 'sandbox' })).toBe(3);
      expect(containerCheck(dir, { WANT: 'none', RB_PREMIUM_ENVIRONMENT: 'production' })).toBe(2);
      expect(containerCheck(dir, { WANT: 'none' })).toBe(2); // a mount without the variables
      expect(containerCheck(join(base, 'absent'), { WANT: 'none' })).toBe(0);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(containerCheck(dir, prodEnv)).toBe(4); // writable: not the read-only mount
    chmodSync(join(dir, 'client-id'), 0o000);
    expect(containerCheck(dir, prodEnv)).toBe(1); // unreadable for the process
  });

  it('verify_finance always ends with the bank connection check; a release without the override is refused', () => {
    expect(script.split('\nverify_finance() {\n')[1]!.split('\n}\n')[0]).toMatch(
      /\n {2}verify_rb_premium$/,
    );
    const rel = mkdtempSync(join(tmp, 'release-norb-'));
    const res = run('bash', [
      '-c',
      `set -Eeuo pipefail\ndie() { echo "DIE $*"; exit 1; }\nok() { echo "OK $*"; }\nPROD_DIR=${rel}; AYVO_RELEASE=abcdef012345\nrelease_dir() { printf '%s/releases/%s' "$PROD_DIR" "\${1:0:12}"; }\ncompose() { echo "COMPOSE $*"; }\n${script
        .split('\n')
        .slice(
          lines.findIndex((l) => l.startsWith('verify_rb_premium() {')),
          lines.findIndex(
            (l, i) =>
              i > lines.findIndex((m) => m.startsWith('verify_rb_premium() {')) && l === '}',
          ) + 1,
        )
        .join('\n')}\nRB_PREMIUM_ACCOUNTS=1234567890:CZK verify_rb_premium`,
    ]);
    expect(res.stdout).toMatch(
      /DIE RB_PREMIUM_ACCOUNTS is set but release abcdef012345 has no compose\.rb-premium\.yml/,
    );
    expect(res.stdout).not.toContain('COMPOSE');
  });
});
