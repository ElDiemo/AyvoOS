import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The public ID edge as it runs (deploy/prod/Caddyfile.id on qr-edge, Caddyfile.acme on the internal
 * Caddy, the networks of compose.yml + compose.id.yml): the real Caddy image and the real files;
 * only certificate issuers are swapped (Caddy's internal CA, or Pebble — the Let's Encrypt test CA —
 * in the ACME chain test). The "web" is a stub that echoes what reaches it. Containers run in CI
 * only, or with AYVO_DOCKER_TESTS=1.
 */
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const run = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const CADDY = 'caddy:2-alpine';
const CURL = 'curlimages/curl:8.11.1';
const PEBBLE = 'ghcr.io/letsencrypt/pebble:2.6.0';

const QR = 'qr.example.test';
const ID = 'id.example.test';
const OS = 'os.example.test';
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';
const prodDir = resolve(import.meta.dirname, '../../../deploy/prod');
const read = (name: string) => readFileSync(join(prodDir, name), 'utf8');

/** Replaces exactly the ACME issuer block of a site (the files must keep that shape). */
function withIssuer(file: string, from: RegExp, to: string): string {
  expect(file).toMatch(from);
  return file.replace(from, to);
}
const QR_TLS = /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge\n\t\t\}\n\t\}\n/;
const ID_TLS = /\ttls \{\n\t\tissuer acme\n\t\}\n/;
const OS_TLS = /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_tlsalpn_challenge\n\t\t\}\n\t\}\n/;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const WEB_STUB = [
  ':3000 {',
  '\theader Set-Cookie "ayvo_session=leak"',
  '\trespond "uri={http.request.uri}|xff={http.request.header.X-Forwarded-For}|cookie={http.request.header.Cookie}|auth={http.request.header.Authorization}|action={http.request.header.Next-Action}|rsc={http.request.header.Rsc}|host={http.request.host}" 200',
  '}',
  '',
].join('\n');

describe.skipIf(!WANT_DOCKER)('public ID edge (Caddyfile.id, Caddyfile.acme)', () => {
  const id = randomBytes(4).toString('hex');
  const nets = {
    public: `ayvo-id-public-${id}`,
    acme: `ayvo-id-acme-${id}`,
    edge: `ayvo-id-edge-${id}`,
  };
  const names = {
    web: `ayvo-id-web-${id}`,
    qr: `ayvo-id-qredge-${id}`,
    caddy: `ayvo-id-caddy-${id}`,
  };
  let port = 0;

  const ask = (
    path: string,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      servername?: string;
      host?: string;
    } = {},
  ) =>
    new Promise<Answer>((done, fail) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: opts.method ?? 'GET',
          servername: opts.servername ?? ID,
          headers: { Host: opts.host ?? ID, ...opts.headers },
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
  const echo = (a: Answer) =>
    Object.fromEntries(a.body.split('|').map((p) => p.split(/=(.*)/s).slice(0, 2)));
  /** curl from a container on the `acme` network — the public edge's position towards caddy. */
  const curlOnAcme = (args: string[]) =>
    run([
      'run',
      '--rm',
      '--network',
      nets.acme,
      CURL,
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--max-time',
      '5',
      ...args,
    ]);

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-id-edge-'));
    writeFileSync(join(dir, 'web.Caddyfile'), WEB_STUB);
    writeFileSync(
      join(dir, 'Caddyfile.qr'),
      withIssuer(read('Caddyfile.qr'), QR_TLS, '\ttls internal\n'),
    );
    writeFileSync(
      join(dir, 'Caddyfile.id'),
      withIssuer(read('Caddyfile.id'), ID_TLS, '\ttls internal\n'),
    );
    writeFileSync(
      join(dir, 'Caddyfile.os'),
      withIssuer(read('Caddyfile'), OS_TLS, '\ttls internal\n'),
    );
    writeFileSync(join(dir, 'Caddyfile.acme'), read('Caddyfile.acme'));
    for (const n of Object.values(nets)) expect(run(['network', 'create', n]).status).toBe(0);
    const caddy = ['run', '-d', '-v'];
    expect(
      run([
        ...caddy,
        `${join(dir, 'web.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        '--name',
        names.web,
        '--network',
        nets.public,
        '--network-alias',
        'web',
        CADDY,
      ]).status,
    ).toBe(0);
    // qr-edge exactly as compose.yml + compose.id.yml: public + acme, :443 published, :80 not.
    const qr = run([
      'create',
      '--name',
      names.qr,
      '--network',
      nets.public,
      '--network-alias',
      'qr-edge',
      '-v',
      `${join(dir, 'Caddyfile.qr')}:/etc/caddy/Caddyfile:ro`,
      '-v',
      `${join(dir, 'Caddyfile.id')}:/etc/caddy/Caddyfile.id:ro`,
      '-e',
      `QR_DOMAIN=${QR}`,
      '-e',
      `ID_DOMAIN=${ID}`,
      '-e',
      'ACME_EMAIL=ops@example.test',
      '-p',
      '127.0.0.1::443',
      CADDY,
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile.id',
      '--adapter',
      'caddyfile',
    ]);
    expect(qr.status, qr.stderr).toBe(0);
    expect(run(['network', 'connect', '--alias', 'qr-edge', nets.acme, names.qr]).status).toBe(0);
    expect(run(['start', names.qr]).status).toBe(0);
    // The internal Caddy: edge + acme (its api/web upstreams are absent: only refusals are tested).
    const internal = run([
      'create',
      '--name',
      names.caddy,
      '--network',
      nets.edge,
      '--network-alias',
      'caddy',
      '-v',
      `${join(dir, 'Caddyfile.os')}:/etc/caddy/Caddyfile:ro`,
      '-v',
      `${join(dir, 'Caddyfile.acme')}:/etc/caddy/Caddyfile.acme:ro`,
      '-e',
      `PROD_DOMAIN=${OS}`,
      '-e',
      `ID_DOMAIN=${ID}`,
      '-e',
      'ACME_EMAIL=ops@example.test',
      CADDY,
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile.acme',
      '--adapter',
      'caddyfile',
    ]);
    expect(internal.status, internal.stderr).toBe(0);
    expect(run(['network', 'connect', '--alias', 'caddy', nets.acme, names.caddy]).status).toBe(0);
    expect(run(['start', names.caddy]).status).toBe(0);
    port = Number(run(['port', names.qr, '443/tcp']).stdout.trim().split(':').pop());
    for (let i = 0; i < 60; i++) {
      const ok = await ask('/employee-card/favicon.ico').then(
        (a) => a.status === 200,
        () => false,
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 180_000);

  afterAll(() => {
    run(['rm', '-f', ...Object.values(names)]);
    for (const n of Object.values(nets)) run(['network', 'rm', n]);
  });

  it('maps the card, photo, contact file and the old PHP link to the web routes', async () => {
    for (const [path, uri] of [
      ['/jana-nova', '/id/jana-nova'],
      ['/jana-nova?vcard', '/id/jana-nova?vcard'],
      ['/jana-nova/photo?version=3', '/id/jana-nova/photo?version=3'],
      ['/jana-nova/contact.vcf?x=1', '/id/jana-nova/contact.vcf'],
      ['/?slug=jana-nova&vcard=1', '/id/jana-nova/contact.vcf'],
      ['/ab', '/id/ab'],
      // Percent-encoding of an allowed character is the same slug (Caddy matches the decoded path).
      ['/jana%2Dnova', '/id/jana-nova'],
      ['/jana-nova%2Fphoto', '/id/jana-nova/photo'],
      [`/${'a'.repeat(80)}`, `/id/${'a'.repeat(80)}`],
    ]) {
      const a = await ask(path!);
      expect([path, a.status, echo(a).uri]).toEqual([path, 200, uri]);
    }
    expect((await ask('/jana-nova', { method: 'HEAD' })).status).toBe(200);
  });

  it('serves exactly the four card assets and the Next.js static files', async () => {
    for (const path of [
      '/employee-card/favicon.ico',
      '/employee-card/legacy-logo.svg',
      '/employee-card/fa-solid-900.woff2',
      '/employee-card/fa-brands-400.woff2',
      '/_next/static/chunks/app.js',
    ]) {
      const a = await ask(path);
      expect([path, a.status, echo(a).uri]).toEqual([path, 200, path]);
    }
  });

  it('answers 404 for everything else: other files, the application, the API, bad slugs and queries', async () => {
    for (const path of [
      '/',
      '/employee-card/README.md',
      '/employee-card/FONT-AWESOME-LICENSE.txt',
      '/employee-card/',
      '/icon.svg',
      '/api/health',
      '/api/public/employee-cards/jana-nova',
      '/admin/users',
      '/id/jana-nova',
      `/q/${TOKEN}`,
      `/${TOKEN}`,
      '/_next/image?url=/x',
      '/_next/data/x.json',
      '/a',
      `/${'a'.repeat(81)}`,
      '/a--b',
      '/-ab',
      '/ab-',
      '/Jana',
      '/jana_nova',
      '/jana-nova/',
      '/jana-nova/x',
      '/jana-nova/photo/x',
      '/%2e%2e/api/health',
      '/jana%2Fnova',
      '/?slug=jana-nova',
      '/?vcard=1&slug=jana-nova',
      '/?slug=jana-nova&vcard=1&x=1',
      '/?slug=jana-nova&slug=petr&vcard=1',
      '/?slug=..%2Fapi&vcard=1',
      '/?slug=a&vcard=1',
    ]) {
      const a = await ask(path);
      expect([path, a.status, a.body]).toEqual([path, 404, 'Not found']);
    }
    // A one-segment name that looks like an application page is only ever a card slug: it reaches
    // /id/<name> (the real web answers "card not found"), never the login or administration.
    for (const name of ['login', 'admin', 'sales', 'api']) {
      const a = await ask(`/${name}`);
      expect([name, echo(a).uri]).toEqual([name, `/id/${name}`]);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      expect((await ask('/jana-nova', { method })).status, method).toBe(404);
    }
  });

  it('forwards no cookie, credentials or Next.js headers; the visitor address is its own', async () => {
    const a = await ask('/jana-nova', {
      headers: {
        Cookie: 'ayvo_session=stolen',
        Authorization: 'Bearer x',
        'Next-Action': 'abc',
        RSC: '1',
        'X-Forwarded-For': '6.6.6.6',
      },
    });
    expect(echo(a)).toMatchObject({ cookie: '', auth: '', action: '', rsc: '', host: ID });
    expect(echo(a).xff).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(echo(a).xff).not.toContain('6.6.6.6');
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(a.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('host names never cross: ID ↔ QR ↔ OS', async () => {
    expect((await ask('/login', { host: OS })).status).toBe(421);
    expect((await ask('/jana-nova', { host: QR })).status).toBe(421);
    expect((await ask(`/${TOKEN}`, { servername: QR, host: ID })).status).toBe(421);
    // QR unchanged next to ID: its token route and its 404s.
    const qr = await ask(`/${TOKEN}`, { servername: QR, host: QR });
    expect([qr.status, echo(qr).uri]).toEqual([200, `/q/${TOKEN}`]);
    expect((await ask('/jana-nova', { servername: QR, host: QR })).status).toBe(404);
    await expect(ask('/', { servername: OS, host: OS })).rejects.toThrow();
  });

  it('from the acme network the internal application stays closed, also with forged headers', () => {
    // HTTPS os.example.test on the internal Caddy: aborted (remote_ip guard, peer is not tailnet).
    for (const forged of [
      [],
      ['-H', 'X-Forwarded-For: 100.64.0.1'],
      ['-H', 'Forwarded: for=100.64.0.1'],
      ['-H', 'X-Real-IP: 100.64.0.1'],
    ]) {
      const r = curlOnAcme([
        '-k',
        '--http1.1',
        '--connect-to',
        `${OS}:443:caddy:443`,
        ...forged,
        `https://${OS}/`,
      ]);
      expect([forged.join(' '), r.status]).toEqual([forged.join(' '), 52]); // empty reply = abort
      const api = curlOnAcme([
        '-k',
        '--http1.1',
        '--connect-to',
        `${OS}:443:caddy:443`,
        ...forged,
        `https://${OS}/api/health`,
      ]);
      expect(api.status).toBe(52);
    }
    // Plain HTTP on the internal Caddy: OS and any other path of the ID host aborted…
    expect(curlOnAcme(['-H', `Host: ${OS}`, 'http://caddy/']).status).toBe(52);
    expect(curlOnAcme(['-H', `Host: ${ID}`, 'http://caddy/admin']).status).toBe(52);
    expect(
      curlOnAcme(['-H', `Host: ${ID}`, 'http://caddy/.well-known/acme-challenge/x/y']).status,
    ).toBe(52);
    // …only the challenge path of the ID host reaches qr-edge (an HTTP answer, not an abort).
    const challenge = curlOnAcme([
      '-H',
      `Host: ${ID}`,
      'http://caddy/.well-known/acme-challenge/abc_DEF-1',
    ]);
    expect(challenge.status).toBe(0);
    expect(challenge.stdout).toMatch(/^[1-5]\d\d$/);
  });
});

describe.skipIf(!WANT_DOCKER)(
  'ID certificate before the DNS change: HTTP-01 through the old server (Pebble)',
  () => {
    const id = randomBytes(4).toString('hex');
    const nets = {
      internet: `ayvo-idca-net-${id}`,
      acme: `ayvo-idca-acme-${id}`,
      public: `ayvo-idca-public-${id}`,
    };
    const names = {
      pebble: `ayvo-idca-pebble-${id}`,
      old: `ayvo-idca-old-${id}`,
      caddy: `ayvo-idca-caddy-${id}`,
      qr: `ayvo-idca-qredge-${id}`,
      web: `ayvo-idca-web-${id}`,
    };
    let dir = '';

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ayvo-id-acme-'));
      // Pebble validates HTTP-01 on port 80 (like Let's Encrypt), resolving names by Docker DNS.
      writeFileSync(
        join(dir, 'pebble.json'),
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
      // The "old server": DNS for the ID host still points here; it forwards ONLY the challenge path,
      // Host kept, to the new server's public :80 (the internal Caddy). Everything else: its own site.
      writeFileSync(
        join(dir, 'old.Caddyfile'),
        [
          '{',
          '\tauto_https off',
          '}',
          `http://${ID} {`,
          '\t@challenge path_regexp ^/\\.well-known/acme-challenge/[A-Za-z0-9_-]+$',
          '\thandle @challenge {',
          '\t\treverse_proxy caddy:80',
          '\t}',
          '\trespond "old PHP site" 200',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'web.Caddyfile'), WEB_STUB);
      writeFileSync(
        join(dir, 'Caddyfile.qr'),
        withIssuer(read('Caddyfile.qr'), QR_TLS, '\ttls internal\n'),
      );
      writeFileSync(
        join(dir, 'Caddyfile.id'),
        withIssuer(
          read('Caddyfile.id'),
          ID_TLS,
          '\ttls {\n\t\tissuer acme {\n\t\t\tdir https://pebble:14000/dir\n\t\t\ttrusted_roots /pebble/pebble.minica.pem\n\t\t\tdisable_tlsalpn_challenge\n\t\t}\n\t}\n',
        ),
      );
      writeFileSync(
        join(dir, 'Caddyfile.os'),
        withIssuer(read('Caddyfile'), OS_TLS, '\ttls internal\n'),
      );
      writeFileSync(join(dir, 'Caddyfile.acme'), read('Caddyfile.acme'));
      for (const n of Object.values(nets)) expect(run(['network', 'create', n]).status).toBe(0);
      const pebbleCert = run(['create', '--name', `${names.pebble}-cert`, PEBBLE]);
      expect(pebbleCert.status).toBe(0);
      run([
        'cp',
        `${names.pebble}-cert:/test/certs/pebble.minica.pem`,
        join(dir, 'pebble.minica.pem'),
      ]);
      run(['rm', '-f', `${names.pebble}-cert`]);
      expect(
        run([
          'run',
          '-d',
          '--name',
          names.pebble,
          '--network',
          nets.internet,
          '--network-alias',
          'pebble',
          '-e',
          'PEBBLE_VA_NOSLEEP=1',
          '-v',
          `${join(dir, 'pebble.json')}:/test/config/pebble-config.json:ro`,
          PEBBLE,
        ]).status,
      ).toBe(0);
      // DNS of the ID host = the old server (Docker alias on the "internet").
      expect(
        run([
          'run',
          '-d',
          '--name',
          names.old,
          '--network',
          nets.internet,
          '--network-alias',
          ID,
          '-v',
          `${join(dir, 'old.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
          CADDY,
        ]).status,
      ).toBe(0);
      expect(
        run([
          'run',
          '-d',
          '--name',
          names.web,
          '--network',
          nets.public,
          '--network-alias',
          'web',
          '-v',
          `${join(dir, 'web.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
          CADDY,
        ]).status,
      ).toBe(0);
      // The new server's internal Caddy: public :80 = reachable from the internet; acme to qr-edge.
      expect(
        run([
          'create',
          '--name',
          names.caddy,
          '--network',
          nets.internet,
          '--network-alias',
          'caddy',
          '-v',
          `${join(dir, 'Caddyfile.os')}:/etc/caddy/Caddyfile:ro`,
          '-v',
          `${join(dir, 'Caddyfile.acme')}:/etc/caddy/Caddyfile.acme:ro`,
          '-e',
          `PROD_DOMAIN=${OS}`,
          '-e',
          `ID_DOMAIN=${ID}`,
          '-e',
          'ACME_EMAIL=ops@example.test',
          CADDY,
          'caddy',
          'run',
          '--config',
          '/etc/caddy/Caddyfile.acme',
          '--adapter',
          'caddyfile',
        ]).status,
      ).toBe(0);
      expect(run(['network', 'connect', nets.acme, names.caddy]).status).toBe(0);
      expect(run(['start', names.caddy]).status).toBe(0);
      // qr-edge: public (web) + acme + internet (its own outbound access to the CA).
      expect(
        run([
          'create',
          '--name',
          names.qr,
          '--network',
          nets.public,
          '-v',
          `${join(dir, 'Caddyfile.qr')}:/etc/caddy/Caddyfile:ro`,
          '-v',
          `${join(dir, 'Caddyfile.id')}:/etc/caddy/Caddyfile.id:ro`,
          '-v',
          `${join(dir, 'pebble.minica.pem')}:/pebble/pebble.minica.pem:ro`,
          '-e',
          `QR_DOMAIN=${QR}`,
          '-e',
          `ID_DOMAIN=${ID}`,
          '-e',
          'ACME_EMAIL=ops@example.test',
          CADDY,
          'caddy',
          'run',
          '--config',
          '/etc/caddy/Caddyfile.id',
          '--adapter',
          'caddyfile',
        ]).status,
      ).toBe(0);
      expect(run(['network', 'connect', '--alias', 'qr-edge', nets.acme, names.qr]).status).toBe(0);
      expect(run(['network', 'connect', nets.internet, names.qr]).status).toBe(0);
      expect(run(['start', names.qr]).status).toBe(0);
    }, 180_000);

    afterAll(() => {
      run(['rm', '-f', ...Object.values(names)]);
      for (const n of Object.values(nets)) run(['network', 'rm', n]);
    });

    it('qr-edge obtains the ID certificate while the name still points to the old server', async () => {
      let logs = '';
      for (
        let i = 0;
        i < 90 && !/certificate obtained successfully.*id\.example\.test/.test(logs);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        logs = run(['logs', names.qr]).stderr + run(['logs', names.qr]).stdout;
      }
      expect(logs).toMatch(/certificate obtained successfully.*id\.example\.test/);
      // The validation request went old server → internal :80 → qr-edge (HTTP-01), not TLS-ALPN.
      expect(logs).toMatch(/"challenge_type":"http-01"/);
      // The internal Caddy holds no ID certificate (only qr-edge obtained one).
      expect(run(['logs', names.caddy]).stderr).not.toMatch(
        /certificate obtained successfully.*id\.example\.test/,
      );
      // The old server keeps serving its own site for every other path.
      const other = run([
        'run',
        '--rm',
        '--network',
        nets.internet,
        CURL,
        '-s',
        `http://${ID}/tomas-hanzl`,
      ]);
      expect(other.stdout).toBe('old PHP site');
    }, 120_000);
  },
);
