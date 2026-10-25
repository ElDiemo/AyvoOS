import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The public marketing site on the PRODUCTION edge (ADR 0040, PR 2), built from the REAL rendered
 * topology: `docker compose config` of compose.yml + compose.id.yml + compose.marketing.yml with
 * fictional values. Containers get exactly the rendered images, commands, environment, mounts
 * (targets), networks and limits; the only change to a mounted Caddyfile is the certificate
 * issuer (Caddy's internal CA, or Pebble — the Let's Encrypt test CA — in the ACME test), applied
 * to the exact shape of the files. The marketing image is built from apps/marketing; "web" is a
 * stub that echoes what reaches it; the API is absent (only refusals are tested).
 * Containers run in CI only, or with AYVO_DOCKER_TESTS=1.
 */
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const run = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const root = resolve(import.meta.dirname, '../../..');
const prodDir = join(root, 'deploy/prod');
const CURL = 'curlimages/curl:8.11.1';
const PEBBLE = 'ghcr.io/letsencrypt/pebble:2.6.0';

const QR = 'qr.example.test';
const ID = 'id.example.test';
const OS = 'os.example.test';
const APEX = 'ayvo.example.test';
const WWW = `www.${APEX}`;
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';

interface Service {
  image: string;
  command?: string[] | null;
  environment?: Record<string, string>;
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
  networks?: Record<string, unknown>;
  read_only?: boolean;
  tmpfs?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  mem_limit?: string | number;
  pids_limit?: number;
}
interface Rendered {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
}

/** The production topology with ID and marketing enabled, as `docker compose config` renders it. */
export function renderProd(): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-prod-render-'));
  const secrets = join(dir, 'secrets');
  mkdirSync(secrets);
  for (const f of ['prod.env', 'prod-auth.env', 'prod-s3.env']) writeFileSync(join(secrets, f), '');
  const env = {
    ...process.env,
    PROD_DOMAIN: OS,
    PROD_TAILNET_IPV4: '100.64.0.2',
    PROD_PUBLIC_IPV4: '192.0.2.10',
    QR_DOMAIN: QR,
    ID_DOMAIN: ID,
    MARKETING_DOMAIN: APEX,
    ACME_EMAIL: 'ops@example.test',
    AYVO_RELEASE: 'fixture',
    AYVO_RELEASE_DIR: dir,
    AYVO_PROD_SECRETS_DIR: secrets,
    POSTGRES_USER: 'fixture',
    POSTGRES_PASSWORD: 'fixture',
    POSTGRES_DB: 'fixture',
    PUBLIC_QR_BASE_URL: `https://${QR}`,
  };
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'ayvo-prod',
      '-f',
      'compose.yml',
      '-f',
      'compose.id.yml',
      '-f',
      'compose.marketing.yml',
      '--env-file',
      join(secrets, 'prod.env'),
      'config',
      '--format',
      'json',
    ],
    { cwd: prodDir, env, encoding: 'utf8' },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as Rendered;
}

/** Replaces exactly the ACME issuer block of a site (the files must keep that shape). */
function withIssuer(file: string, from: RegExp, to: string): string {
  expect(file).toMatch(from);
  return file.replace(from, to);
}
const ISSUERS: Record<string, RegExp> = {
  'Caddyfile.qr': /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge\n\t\t\}\n\t\}\n/,
  'Caddyfile.id': /\ttls \{\n\t\tissuer acme\n\t\}\n/,
  Caddyfile: /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_tlsalpn_challenge\n\t\t\}\n\t\}\n/,
  'sites/marketing.caddy': /\ttls \{\n\t\tissuer acme\n\t\}\n/,
};

const WEB_STUB = [
  ':3000 {',
  '\theader Set-Cookie "ayvo_session=leak"',
  '\trespond "uri={http.request.uri}|host={http.request.host}|cookie={http.request.header.Cookie}" 200',
  '}',
  '',
].join('\n');

/** A throwaway copy of the rendered topology: networks, and containers created from the render. */
class Topology {
  readonly id = randomBytes(4).toString('hex');
  readonly dir = mkdtempSync(join(tmpdir(), 'ayvo-mkt-edge-'));
  private readonly containers: string[] = [];
  private readonly networks: string[] = [];

  constructor(private readonly r: Rendered) {}

  net(logical: string): string {
    return `ayvo-mkt-${logical}-${this.id}`;
  }
  name(service: string): string {
    return `ayvo-mkt-${service}-${this.id}`;
  }

  createNetworks(logical: string[]) {
    for (const n of logical) {
      const args = ['network', 'create'];
      if (this.r.networks[n]?.internal) args.push('--internal');
      const res = run([...args, this.net(n)]);
      expect(res.status, res.stderr).toBe(0);
      this.networks.push(this.net(n));
    }
  }

  /**
   * A container exactly as rendered: image (unless given), command, environment, read-only,
   * tmpfs, capabilities, limits, bind mounts at their targets (Caddyfiles copied with only the
   * issuer replaced), every rendered network with the service name as alias. Named data volumes
   * become tmpfs at their targets (throwaway). Not started.
   */
  create(
    service: string,
    opts: {
      image?: string;
      issuer?: (file: string) => string;
      publish?: string;
      extraNets?: string[];
      mounts?: string[];
    } = {},
  ) {
    const s = this.r.services[service]!;
    const nets = Object.keys(s.networks ?? {});
    const args = [
      'create',
      '--name',
      this.name(service),
      '--network',
      this.net(nets[0]!),
      '--network-alias',
      service,
    ];
    for (const [k, v] of Object.entries(s.environment ?? {})) args.push('-e', `${k}=${v}`);
    if (s.read_only) args.push('--read-only');
    for (const t of s.tmpfs ?? []) args.push('--tmpfs', t);
    for (const c of s.cap_drop ?? []) args.push('--cap-drop', c);
    for (const c of s.cap_add ?? []) args.push('--cap-add', c);
    if (s.mem_limit) args.push('--memory', String(s.mem_limit));
    if (s.pids_limit) args.push('--pids-limit', String(s.pids_limit));
    for (const v of s.volumes ?? []) {
      // Named data volumes (certificates, ACME state) become throwaway tmpfs at the same target.
      if (v.type === 'volume') {
        args.push('--tmpfs', v.target);
        continue;
      }
      if (v.type !== 'bind') continue;
      // Keyed by the path inside deploy/prod (two files are named marketing.caddy).
      const name = relative(prodDir, v.source);
      let content = readFileSync(v.source, 'utf8');
      if (ISSUERS[name] && opts.issuer)
        content = withIssuer(content, ISSUERS[name], opts.issuer(name));
      const copy = join(this.dir, `${service}-${name.replace(/\//g, '_')}`);
      writeFileSync(copy, content);
      args.push('-v', `${copy}:${v.target}:ro`);
    }
    for (const m of opts.mounts ?? []) args.push('-v', m);
    if (opts.publish) args.push('-p', opts.publish);
    args.push(opts.image ?? s.image, ...(s.command ?? []));
    const res = run(args);
    expect(res.status, res.stderr).toBe(0);
    this.containers.push(this.name(service));
    for (const n of [...nets.slice(1), ...(opts.extraNets ?? [])]) {
      const c = run(['network', 'connect', '--alias', service, this.net(n), this.name(service)]);
      expect(c.status, c.stderr).toBe(0);
    }
  }

  start(service: string) {
    const res = run(['start', this.name(service)]);
    expect(res.status, res.stderr).toBe(0);
  }

  /** A plain helper container (stub web, the old server, Pebble). */
  plain(name: string, net: string, alias: string, args: string[]) {
    const res = run([
      'run',
      '-d',
      '--name',
      `ayvo-mkt-${name}-${this.id}`,
      '--network',
      this.net(net),
      '--network-alias',
      alias,
      ...args,
    ]);
    expect(res.status, res.stderr).toBe(0);
    this.containers.push(`ayvo-mkt-${name}-${this.id}`);
  }

  cleanup() {
    run(['rm', '-f', ...this.containers]);
    for (const n of this.networks) run(['network', 'rm', n]);
  }
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe.skipIf(!WANT_DOCKER)('the marketing site on the public edge (rendered topology)', () => {
  let r: Rendered;
  let t: Topology;
  let port = 0;
  const marketingImage = `ayvo-mkt-edge-test:${randomBytes(3).toString('hex')}`;

  const ask = (path: string, opts: { method?: string; host?: string; servername?: string } = {}) =>
    new Promise<Answer>((done, fail) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: opts.method ?? 'GET',
          servername: opts.servername ?? APEX,
          headers: { Host: opts.host ?? APEX, Cookie: 'ayvo_session=secret' },
          rejectUnauthorized: false, // Caddy's internal test CA; the real chain is tested below
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', fail);
      req.end();
    });
  /** curl from the `acme` network (the position of a public :80 request reaching the internal Caddy). */
  const curlOnAcme = (args: string[]) =>
    run([
      'run',
      '--rm',
      '--network',
      t.net('acme'),
      CURL,
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code} %{redirect_url}',
      '--max-time',
      '5',
      ...args,
    ]);

  beforeAll(async () => {
    r = renderProd();
    t = new Topology(r);
    const build = run(['build', '-q', '-t', marketingImage, join(root, 'apps/marketing')]);
    expect(build.status, build.stderr).toBe(0);
    t.createNetworks([
      ...new Set(
        ['caddy', 'qr-edge', 'marketing', 'web'].flatMap((s) =>
          Object.keys(r.services[s]!.networks ?? {}),
        ),
      ),
    ]);
    writeFileSync(join(t.dir, 'web.Caddyfile'), WEB_STUB);
    t.plain('web', 'public', 'web', [
      '-v',
      `${join(t.dir, 'web.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      'caddy:2-alpine',
    ]);
    t.create('marketing', { image: marketingImage });
    t.start('marketing');
    t.create('qr-edge', { issuer: () => '\ttls internal\n', publish: '127.0.0.1::443' });
    t.start('qr-edge');
    t.create('caddy', { issuer: () => '\ttls internal\n' });
    t.start('caddy');
    port = Number(
      run(['port', t.name('qr-edge'), '443/tcp'])
        .stdout.trim()
        .split(':')
        .pop(),
    );
    for (let i = 0; i < 90; i++) {
      const ok = await ask('/cz/').then(
        (a) => a.status === 200,
        () => false,
      );
      if (ok) break;
      await new Promise((res) => setTimeout(res, 500));
    }
  }, 240_000);

  afterAll(() => {
    t?.cleanup();
    run(['image', 'rm', marketingImage]);
  });

  it('the rendered topology: one more site file each, the ID command kept, marketing on its own network', () => {
    const qr = r.services['qr-edge']!;
    expect(qr.command).toEqual([
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile.id',
      '--adapter',
      'caddyfile',
    ]);
    expect(
      qr
        .volumes!.filter((v) => v.type === 'bind')
        .map((v) => v.target)
        .sort(),
    ).toEqual([
      '/etc/caddy/Caddyfile',
      '/etc/caddy/Caddyfile.id',
      '/etc/caddy/sites/marketing.caddy',
    ]);
    expect(Object.keys(r.services.marketing!.networks!)).toEqual(['marketing']);
    expect(r.networks.marketing?.internal).toBe(true);
    expect(Object.keys(r.services.web!.networks!).sort()).not.toContain('marketing');
    expect(Object.keys(r.services.api!.networks!).sort()).not.toContain('marketing');
    expect(r.services.marketing!.read_only).toBe(true);
    expect(r.services.marketing!.cap_drop).toEqual(['ALL']);
  });

  it('serves the static site on the apex with its own strict headers and HSTS; no cookie reaches it', async () => {
    const page = await ask('/cz/');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<html lang="cs">/);
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'none'/);
    expect(page.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(page.headers['x-robots-tag']).toBe('all');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.headers.server).toBeUndefined();
    expect((await ask('/assets/site.css')).headers['content-type']).toMatch(/^text\/css/);
  });

  it('www redirects to the apex; only GET/HEAD; the OS, API and old WordPress paths are not here', async () => {
    const www = await ask('/cz/?x=1', { host: WWW, servername: WWW });
    expect([www.status, www.headers.location]).toEqual([301, `https://${APEX}/cz/?x=1`]);
    for (const method of ['POST', 'PUT', 'DELETE'])
      expect((await ask('/', { method })).status).toBe(405);
    for (const path of [
      '/api/health',
      '/login',
      '/q/x',
      '/id/x',
      '/wp-admin/',
      '/_next/static/x.js',
    ])
      expect([path, (await ask(path)).status]).toEqual([path, 404]);
    expect((await ask('/en')).headers.location).toBe('/');
  });

  it('host names never cross: marketing ↔ QR ↔ ID ↔ OS', async () => {
    expect((await ask('/cz/', { host: OS })).status).toBe(421);
    expect((await ask(`/${TOKEN}`, { host: QR })).status).toBe(421);
    const qr = await ask(`/${TOKEN}`, { host: QR, servername: QR });
    expect(qr.body).toContain(`uri=/q/${TOKEN}`);
    const id = await ask('/jana-novakova', { host: ID, servername: ID });
    expect(id.body).toContain('uri=/id/jana-novakova');
    expect((await ask('/cz/', { host: ID, servername: ID })).status).toBe(404);
  });

  it('the marketing container reaches nothing: not web, not the API, not the internet', () => {
    for (const target of ['http://web:3000/', 'http://api:4000/api/health', 'http://example.com/'])
      expect(
        run(['exec', t.name('marketing'), 'wget', '-q', '-T', '3', '-O', '/dev/null', target])
          .status,
      ).not.toBe(0);
  });

  it('public :80 on the internal Caddy: challenges of apex and www to qr-edge, else → https; OS still closed', () => {
    for (const host of [APEX, WWW]) {
      const redirect = curlOnAcme(['-H', `Host: ${host}`, 'http://caddy/cz/?a=1']);
      expect(redirect.stdout).toBe(`301 https://${host}/cz/?a=1`);
      const challenge = curlOnAcme([
        '-H',
        `Host: ${host}`,
        'http://caddy/.well-known/acme-challenge/abc_DEF-1',
      ]);
      expect(challenge.status).toBe(0);
      expect(challenge.stdout).toMatch(/^[1-5]\d\d /);
    }
    expect(curlOnAcme(['-H', `Host: ${OS}`, 'http://caddy/']).status).toBe(52);
    expect(curlOnAcme(['-H', `Host: ${ID}`, 'http://caddy/admin']).status).toBe(52);
  });
});

describe.skipIf(!WANT_DOCKER)(
  'apex and www certificates before the DNS change: HTTP-01 through the old server (Pebble)',
  () => {
    let t: Topology;
    let r: Rendered;

    beforeAll(() => {
      r = renderProd();
      t = new Topology(r);
      t.createNetworks([
        'internet',
        ...new Set(['caddy', 'qr-edge'].flatMap((s) => Object.keys(r.services[s]!.networks ?? {}))),
      ]);
      writeFileSync(
        join(t.dir, 'pebble.json'),
        JSON.stringify({
          pebble: {
            listenAddress: '0.0.0.0:14000',
            managementListenAddress: '0.0.0.0:15000',
            certificate: 'test/certs/localhost/cert.pem',
            privateKey: 'test/certs/localhost/key.pem',
            httpPort: 80,
            tlsPort: 443,
            ocspResponderURL: '',
            externalAccountBindingRequired: false,
          },
        }),
      );
      const cert = run(['create', '--name', `ayvo-mkt-pebcert-${t.id}`, PEBBLE]);
      expect(cert.status).toBe(0);
      run([
        'cp',
        `ayvo-mkt-pebcert-${t.id}:/test/certs/pebble.minica.pem`,
        join(t.dir, 'pebble.minica.pem'),
      ]);
      run(['rm', '-f', `ayvo-mkt-pebcert-${t.id}`]);
      t.plain('pebble', 'internet', 'pebble', [
        '-e',
        'PEBBLE_VA_NOSLEEP=1',
        '-v',
        `${join(t.dir, 'pebble.json')}:/test/config/pebble-config.json:ro`,
        PEBBLE,
      ]);
      // The "old server": DNS for apex and www still points here; it forwards ONLY the challenge
      // path, Host kept, to the new server's public :80 (the internal Caddy).
      const old = (host: string) =>
        [
          `http://${host} {`,
          '\t@challenge path_regexp ^/\\.well-known/acme-challenge/[A-Za-z0-9_-]+$',
          '\thandle @challenge {',
          '\t\treverse_proxy caddy:80',
          '\t}',
          '\trespond "old WordPress" 200',
          '}',
        ].join('\n');
      writeFileSync(
        join(t.dir, 'old.Caddyfile'),
        ['{', '\tauto_https off', '}', old(APEX), old(WWW), ''].join('\n'),
      );
      t.plain('old', 'internet', APEX, [
        '--network-alias',
        WWW,
        '-v',
        `${join(t.dir, 'old.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        'caddy:2-alpine',
      ]);
      const pebbleIssuer =
        '\ttls {\n\t\tissuer acme {\n\t\t\tdir https://pebble:14000/dir\n\t\t\ttrusted_roots /etc/caddy/pebble.minica.pem\n\t\t\tdisable_tlsalpn_challenge\n\t\t}\n\t}\n';
      t.create('caddy', { issuer: () => '\ttls internal\n', extraNets: ['internet'] });
      t.create('qr-edge', {
        issuer: (name) => (name === 'sites/marketing.caddy' ? pebbleIssuer : '\ttls internal\n'),
        extraNets: ['internet'],
        // The Pebble root (test only), next to the rendered mounts.
        mounts: [`${join(t.dir, 'pebble.minica.pem')}:/etc/caddy/pebble.minica.pem:ro`],
      });
      t.start('caddy');
      t.start('qr-edge');
    }, 180_000);

    afterAll(() => t?.cleanup());

    it('qr-edge obtains both certificates while the names still point to the old server', async () => {
      let logs = '';
      const both = () =>
        new RegExp(
          `certificate obtained successfully.*"identifier":"${APEX.replace(/\./g, '\\.')}"`,
        ).test(logs) &&
        new RegExp(
          `certificate obtained successfully.*"identifier":"${WWW.replace(/\./g, '\\.')}"`,
        ).test(logs);
      for (let i = 0; i < 120 && !both(); i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const l = run(['logs', t.name('qr-edge')]);
        logs = l.stderr + l.stdout;
      }
      expect(both(), logs.slice(-3000)).toBe(true);
      expect(logs).toMatch(/"challenge_type":"http-01"/);
      const internal = run(['logs', t.name('caddy')]);
      expect(internal.stderr + internal.stdout).not.toMatch(
        /certificate obtained successfully.*ayvo\.example\.test/,
      );
      const other = run([
        'run',
        '--rm',
        '--network',
        t.net('internet'),
        CURL,
        '-s',
        `http://${APEX}/`,
      ]);
      expect(other.stdout).toBe('old WordPress');
    }, 180_000);
  },
);
