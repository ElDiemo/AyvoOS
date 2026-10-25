import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The public ID edge in a real browser: the real Caddyfile.qr + Caddyfile.id in front of the real
 * e2e web/API with a synthetic published card. Test-only changes to the copied files: Caddy's
 * internal CA instead of ACME, the upstream 127.0.0.1:3100 (the e2e web) instead of web:3000, and
 * loopback-only listeners on high ports (host network, nothing exposed). CI, or AYVO_DOCKER_TESTS=1.
 */
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const ID = 'id.e2e.test';
const PORT = 18443;
const ORIGIN = `https://${ID}:${PORT}`;
const prodDir = resolve(import.meta.dirname, '../../../deploy/prod');
const name = `ayvo-e2e-id-edge-${randomUUID().slice(0, 8)}`;
const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

test.use({
  storageState: 'e2e/.auth/admin.json',
  ignoreHTTPSErrors: true, // Caddy's internal test CA; the real certificate chain is tested in the API suite
  launchOptions: { args: [`--host-resolver-rules=MAP ${ID} 127.0.0.1`] },
});
test.skip(!WANT_DOCKER, 'needs Docker (CI or AYVO_DOCKER_TESTS=1)');

function edgeFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-e2e-id-edge-'));
  const qr = readFileSync(join(prodDir, 'Caddyfile.qr'), 'utf8');
  const globals = /^\{\n\temail \{\$ACME_EMAIL\}\n/m;
  expect(qr).toMatch(globals);
  const qrTest = qr
    .replace(
      globals,
      '{\n\temail {$ACME_EMAIL}\n\tdefault_bind 127.0.0.1\n\thttp_port 18080\n\thttps_port 18443\n',
    )
    .replace(
      /\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge\n\t\t\}\n\t\}\n/,
      '\ttls internal\n',
    )
    .replace('reverse_proxy web:3000 {', 'reverse_proxy 127.0.0.1:3100 {');
  expect(qrTest).toContain('reverse_proxy 127.0.0.1:3100 {');
  const id = readFileSync(join(prodDir, 'Caddyfile.id'), 'utf8').replace(
    /\ttls \{\n\t\tissuer acme\n\t\}\n/,
    '\ttls internal\n',
  );
  expect(id).toContain('\ttls internal\n');
  writeFileSync(join(dir, 'Caddyfile'), qrTest);
  writeFileSync(join(dir, 'Caddyfile.id'), id);
  return dir;
}

const ready = () =>
  new Promise<boolean>((done) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/employee-card/favicon.ico',
        servername: ID,
        headers: { Host: ID },
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      },
    );
    req.on('error', () => done(false));
    req.end();
  });

/** A request to the edge outside the browser: 127.0.0.1 with the ID name as SNI and Host. */
const edge = (path: string, method = 'GET') =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((done, fail) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        servername: ID,
        headers: { Host: `${ID}:${PORT}` },
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

test('a published card through the public ID edge: page, photo, logo, fonts, vCard and old links', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // A synthetic card with a photo, published through the normal administration.
  const slug = `edge-${randomUUID().slice(0, 8)}`;
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email: `edge-${randomUUID()}@ayvo.test`,
      displayName: 'Eva Hranová',
      roles: ['SALES'],
      siteIds: [],
      warehouseCodes: [],
      reason: 'synthetic public ID edge test',
    },
  });
  expect(created.status()).toBe(201);
  const user = (await created.json()) as { id: string };
  const base = `/api/admin/identity/users/${user.id}/business-card`;
  const require = createRequire(import.meta.url);
  const { createCanvas } = require('../../api/node_modules/@napi-rs/canvas') as {
    createCanvas: (
      w: number,
      h: number,
    ) => {
      getContext: (t: '2d') => { fillStyle: string; fillRect: (...n: number[]) => void };
      toBuffer: (mime: 'image/png') => Buffer;
    };
  };
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#a8a29e';
  context.fillRect(0, 0, 64, 64);
  const png = canvas.toBuffer('image/png');
  const photo = await page.request.post(`${base}/photos`, {
    multipart: {
      requestId: randomUUID(),
      file: { name: 'p.png', mimeType: 'image/png', buffer: png },
    },
  });
  expect(photo.status()).toBe(201);
  const fields = {
    name: 'Eva Hranová',
    role: 'Obchodní zástupkyně',
    company: '',
    tagline: 'Syntetická vizitka pro test veřejného vstupu.',
    phone: '+420 111 222 444',
    email: 'eva@example.com',
    website: 'https://example.com',
    linkedin: '',
    photoId: ((await photo.json()) as { id: string }).id,
  };
  const saved = await page.request.post(base, {
    data: { requestId: randomUUID(), expectedVersion: 0, reason: 'synthetic', slug, fields },
  });
  expect(saved.status()).toBe(200);
  const version = ((await saved.json()) as { card: { version: number } }).card.version;
  const published = await page.request.post(`${base}/publish`, {
    data: { requestId: randomUUID(), expectedVersion: version, reason: 'synthetic' },
  });
  expect(published.status()).toBe(200);

  const dir = edgeFiles();
  const started = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '-v',
    `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    '-v',
    `${join(dir, 'Caddyfile.id')}:/etc/caddy/Caddyfile.id:ro`,
    '-e',
    'QR_DOMAIN=qr.e2e.test',
    '-e',
    `ID_DOMAIN=${ID}`,
    '-e',
    'ACME_EMAIL=ops@example.test',
    'caddy:2-alpine',
    'caddy',
    'run',
    '--config',
    '/etc/caddy/Caddyfile.id',
    '--adapter',
    'caddyfile',
  ]);
  expect(started.status, started.stderr).toBe(0);
  try {
    await expect.poll(ready, { timeout: 60_000 }).toBe(true);

    // Every request the page makes goes to the ID host and succeeds.
    const responses: { path: string; status: number; host: string }[] = [];
    page.on('response', (r) => {
      const u = new URL(r.url());
      responses.push({ path: u.pathname, status: r.status(), host: u.host });
    });
    await page.goto(`${ORIGIN}/${slug}`);
    await expect(page.getByRole('heading', { name: 'Eva Hranová' })).toBeVisible();
    const card = page.getByRole('article');
    for (const alt of ['Eva Hranová', 'AYVO®']) {
      const img = card.getByRole('img', { name: alt, exact: true });
      await expect
        .poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
        .toBe(true);
    }
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    });
    expect(fonts).toContain('AYVO Card Icons'); // the pinned Font Awesome files (README)
    expect(responses.filter((r) => r.host !== `${ID}:${PORT}`)).toEqual([]);
    expect(responses.filter((r) => r.status >= 400)).toEqual([]);
    expect(responses.map((r) => r.path)).toEqual(
      expect.arrayContaining([`/${slug}`, `/${slug}/photo`, '/employee-card/legacy-logo.svg']),
    );
    expect(
      responses.some((r) => /\/employee-card\/fa-(solid-900|brands-400)\.woff2$/.test(r.path)),
    ).toBe(true);
    expect((await edge('/employee-card/favicon.ico')).status).toBe(200);

    // Save contact from the page: a UTF-8 vCard under the public root path.
    const download = page.waitForEvent('download');
    await card.getByRole('link', { name: 'Save contact' }).click();
    const file = await (await download).path();
    const vcard = readFileSync(file!, 'utf8');
    expect(vcard).toContain('FN:Eva Hranová');
    expect(vcard).toContain('EMAIL;TYPE=WORK:eva@example.com');

    // The old PHP links: /<slug>?vcard (redirect) and /?slug=<slug>&vcard=1.
    const viaQuery = await edge(`/${slug}?vcard`);
    expect(viaQuery.status).toBeGreaterThanOrEqual(300);
    expect(viaQuery.status).toBeLessThan(400);
    expect(new URL(String(viaQuery.headers['location']), `${ORIGIN}/${slug}?vcard`).pathname).toBe(
      `/${slug}/contact.vcf`,
    );
    const legacy = await edge(`/?slug=${slug}&vcard=1`);
    expect(legacy.status).toBe(200);
    expect(legacy.headers['content-type']).toBe('text/vcard; charset=utf-8');
    expect(legacy.body).toContain('FN:Eva Hranová');

    // Never the application: unknown card, internal paths, API, other methods.
    for (const path of [
      `/unknown-${slug}`,
      '/admin/users',
      '/api/health',
      '/login/x',
      '/employee-card/README.md',
    ]) {
      expect([path, (await edge(path)).status]).toEqual([path, 404]);
    }
    expect((await edge(`/${slug}`, 'POST')).status).toBe(404);

    // Hidden: the same public URLs disappear.
    const current = (await (await page.request.get(base)).json()) as { card: { version: number } };
    const hidden = await page.request.post(`${base}/hide`, {
      data: { requestId: randomUUID(), expectedVersion: current.card.version, reason: 'synthetic' },
    });
    expect(hidden.status()).toBe(200);
    for (const path of [`/${slug}`, `/${slug}/contact.vcf`, `/?slug=${slug}&vcard=1`]) {
      expect([path, (await edge(path)).status]).toEqual([path, 404]);
    }
  } finally {
    docker(['rm', '-f', name]);
  }
});
