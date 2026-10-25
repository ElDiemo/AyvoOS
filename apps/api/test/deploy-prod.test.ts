import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
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
    // Without the physically validated QR values it renders them empty (not set, ADR 0034).
    writeFileSync(
      join(secrets, 'no-qr-settings.env'),
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
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
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n',
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
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
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
      'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
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
