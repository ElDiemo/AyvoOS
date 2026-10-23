import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The public QR edge (deploy/prod/Caddyfile.qr, ADR 0035, doc 037) as it runs: the real Caddy
 * image with the real file, only the certificate issuer swapped for Caddy's internal CA, in front
 * of a stub "web" that echoes what reaches it. Containers are started in CI only (or with
 * AYVO_DOCKER_TESTS=1): Docker on the DEV server is not under the build memory limits.
 */
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const run = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

const QR = 'qr.example.test';
const INTERNAL = 'os.example.test';
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';
const FAIL = 'FAILFAILFAILFAILFAILFA';
const prodDir = resolve(import.meta.dirname, '../../../deploy/prod');

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe.skipIf(!WANT_DOCKER)('public QR edge (Caddy, doc 037)', () => {
  const id = randomBytes(4).toString('hex');
  const net = `ayvo-qr-edge-test-${id}`;
  const web = `ayvo-qr-edge-web-${id}`;
  const edge = `ayvo-qr-edge-${id}`;
  let port = 0;

  const ask = (
    path: string,
    opts: { method?: string; headers?: Record<string, string>; servername?: string } = {},
  ) =>
    new Promise<Answer>((done, fail) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: opts.method ?? 'GET',
          servername: opts.servername ?? QR,
          headers: { Host: QR, ...opts.headers },
          rejectUnauthorized: false,
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

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-qr-edge-'));
    // The stub web: answers what it received (or 500 with internals for the FAIL token).
    writeFileSync(
      join(dir, 'web.Caddyfile'),
      [
        ':3000 {',
        `\t@fail path /q/${FAIL}`,
        '\thandle @fail {',
        '\t\trespond "Error: stack trace at /app/apps/web 172.18.0.5" 500',
        '\t}',
        '\theader Set-Cookie "ayvo_session=leak"',
        '\theader X-Powered-By "Next.js"',
        '\trespond "uri={http.request.uri}|xff={http.request.header.X-Forwarded-For}|cookie={http.request.header.Cookie}|auth={http.request.header.Authorization}|action={http.request.header.Next-Action}|rsc={http.request.header.Rsc}|path={http.request.header.X-Ayvo-Path}|host={http.request.host}" 200',
        '}',
        '',
      ].join('\n'),
    );
    // The real edge file; only the ACME issuer becomes Caddy's internal CA.
    const real = readFileSync(join(prodDir, 'Caddyfile.qr'), 'utf8');
    const tls = /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge\n\t\t\}\n\t\}\n/;
    expect(real).toMatch(tls);
    writeFileSync(join(dir, 'edge.Caddyfile'), real.replace(tls, '\ttls internal\n'));

    expect(run(['network', 'create', net]).status).toBe(0);
    const caddy = ['run', '-d', '--network', net, '-v'];
    expect(
      run([
        ...caddy,
        `${join(dir, 'web.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        '--name',
        web,
        '--network-alias',
        'web',
        'caddy:2-alpine',
      ]).status,
    ).toBe(0);
    const started = run([
      ...caddy,
      `${join(dir, 'edge.Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      '--name',
      edge,
      '-e',
      `QR_DOMAIN=${QR}`,
      '-e',
      'ACME_EMAIL=ops@example.test',
      '-p',
      '127.0.0.1::443',
      'caddy:2-alpine',
    ]);
    expect(started.status, started.stderr).toBe(0);
    port = Number(run(['port', edge, '443/tcp']).stdout.trim().split(':').pop());
    for (let i = 0; i < 60; i++) {
      const ok = await ask('/icon.svg').then(
        (a) => a.status === 200,
        () => false,
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 120_000);

  afterAll(() => {
    run(['rm', '-f', edge, web]);
    run(['network', 'rm', net]);
  });

  it('GET /<token> reaches only /q/<token>: no query, cookie, credentials or Next.js headers', async () => {
    const a = await ask(`/${TOKEN}?_rsc=1&next=/admin`, {
      headers: {
        Cookie: 'ayvo_session=stolen',
        Authorization: 'Bearer x',
        'Next-Action': 'abc',
        RSC: '1',
        'X-Ayvo-Path': '/admin',
        'X-Forwarded-For': '6.6.6.6',
      },
    });
    expect(a.status).toBe(200);
    const echo = Object.fromEntries(a.body.split('|').map((p) => p.split(/=(.*)/s).slice(0, 2)));
    expect(echo).toMatchObject({
      uri: `/q/${TOKEN}`,
      cookie: '',
      auth: '',
      action: '',
      rsc: '',
      path: '',
      host: QR,
    });
    // The visitor's own address, never a value the visitor chose.
    expect(echo.xff).not.toContain('6.6.6.6');
    expect(echo.xff).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(a.headers['x-powered-by']).toBeUndefined();
    expect(a.headers['server']).toBeUndefined();
    expect(a.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(a.headers['strict-transport-security']).toBeDefined();
  });

  it('serves the static files of the page and nothing else of the application or the API', async () => {
    const asset = await ask('/_next/static/chunks/app.js');
    expect([asset.status, asset.body]).toEqual([
      200,
      expect.stringContaining('uri=/_next/static/'),
    ]);
    for (const path of [
      '/',
      '/login',
      '/sales',
      '/admin',
      `/q/${TOKEN}`,
      '/api/health',
      `/api/public/bottles/${TOKEN}`,
      '/api/auth/login',
      '/_next/image?url=/x',
      '/_next/data/x.json',
      `/${TOKEN.slice(1)}`,
      `/${TOKEN}A`,
      `/${TOKEN}/admin`,
      `/%2e%2e/api/health`,
      `/${TOKEN.slice(0, 21)}%2F`,
    ]) {
      const a = await ask(path);
      expect([path, a.status, a.body]).toEqual([path, 404, 'Not found']);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await ask(`/${TOKEN}`, { method })).status, method).toBe(404);
    }
  });

  it('another host name behind the QR certificate, or another TLS name, gets nothing', async () => {
    const misdirected = await ask('/login', { headers: { Host: INTERNAL } });
    expect(misdirected.status).toBe(421);
    expect(misdirected.body).not.toContain('uri=');
    await expect(
      ask(`/${TOKEN}`, { servername: INTERNAL, headers: { Host: INTERNAL } }),
    ).rejects.toThrow();
  });

  it('an upstream failure is a calm public answer without internals', async () => {
    const a = await ask(`/${FAIL}`);
    expect(a.status).toBe(503);
    expect(a.body).toBe('This AYVO page is temporarily unavailable.');
  });
});
