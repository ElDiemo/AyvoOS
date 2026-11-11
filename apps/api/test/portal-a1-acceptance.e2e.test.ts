import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FinancePortalGrantResult } from '@ayvo/types';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { prodSecrets, renderProd, repoRoot } from './support/prod-compose.js';
import { hasDatabase } from './support/test-app.js';

/**
 * Acceptance of doc 064 option A1 on the DEV server (review 5858165597, "[Akceptace]"): one REAL
 * invoice package from its creation in Finance to its download by a slow client, through the same
 * configuration as PROD:
 * - Finance's package limits and portal-web's deadline are read from the rendered PROD Compose
 *   (compose.yml + compose.portal.yml), never typed here;
 * - the edge is a real Caddy with the public edge's global options taken verbatim from
 *   deploy/prod/Caddyfile.qr (write 30 s …) and the site deploy/prod/sites/portal.caddy, changed
 *   in one place only: `tls internal` instead of ACME (no certificate is requested from DEV);
 * - the core, Finance (real HTTP, real DB roles, real Redis) and the built portal-web
 *   (`next start`) as in portal-web-walk.e2e.test.ts; one synthetic payer with one synthetic
 *   hotel and as many TEST invoices as Finance packs at most, whose stored PDFs fill the package
 *   up to Finance's byte cap; the account is invited and activated through the portal (memory
 *   mail, test DB) — nothing on the DEV preview, no real account or mail.
 * - the client is curl limited to 8 Mbit/s (1 000 000 B/s), trusting only this run's Caddy CA.
 * The ZIP must arrive complete (Content-Length, every PDF byte-identical to the issued one, the
 * manifest) and in time. Measurements go to PORTAL_A1_REPORT (JSON) when set.
 *
 * Opt-in (needs Docker, the caddy image and `pnpm --filter @ayvo/portal build` first):
 *   PORTAL_A1_ACCEPTANCE=1 pnpm --filter @ayvo/api exec vitest run test/portal-a1-acceptance.e2e.test.ts
 */
const enabled = hasDatabase && process.env.PORTAL_A1_ACCEPTANCE === '1';
const CADDY_IMAGE = process.env.PORTAL_A1_CADDY_IMAGE ?? 'caddy:2.11.9-alpine';
/**
 * Optional: portal-web as its real image (a container with PROD's limits: read-only, no
 * capabilities, 256 MiB, 0.5 CPU) instead of `next start` — e.g. an image already on the DEV host.
 * Its memory is then the container's cgroup (memory.current, incl. socket buffers).
 */
const PORTAL_IMAGE = process.env.PORTAL_A1_PORTAL_IMAGE;
const DOMAIN = 'portal.a1-acceptance.test';
const EDGE_PORT = 18443;
const PORTAL_PORT = 3200; // as in PROD (portal-web:3200)
const BASE = `https://${DOMAIN}:${EDGE_PORT}`;
const RATE = 1_000_000; // bytes per second = 8 Mbit/s
const PASSWORD = 'Dlouhe portalove heslo AYVO 2026';
const portalDir = resolve(import.meta.dirname, '../../portal');
const coreToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const otp = (secret: string, offsetSteps = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });

/** The STORE-only ZIP Finance writes: name → bytes (sizes from the local headers). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.set(name, zip.subarray(start, start + size));
    at = start + size;
  }
  // The central directory must follow and end the file (a cut transfer never parses).
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length) throw new Error('no end of central directory');
  if (zip.readUInt16LE(end + 10) !== out.size) throw new Error('central directory count differs');
  return out;
}

/** The PROD configuration of the two units, from the real Compose files (fictional secrets). */
function prodConfig(): { finance: Record<string, string>; portal: Record<string, string> } {
  const c = 'p'.repeat(43);
  const q = 'q'.repeat(43);
  const secrets = prodSecrets(
    `PORTAL_DOMAIN=portal.example.test\nPORTAL_CORE_TOKEN=${c}\nPORTAL_FINANCE_TOKEN=${q}\n` +
      `PORTAL_SERVICE_TOKEN_SHA256=${sha(c)}\nPORTAL_FINANCE_TOKEN_SHA256=${sha(q)}\n`,
  );
  try {
    const r = renderProd(secrets, {
      overrides: ['compose.portal.yml'],
      profiles: ['portal', 'finance'],
      env: { PORTAL_DOMAIN: 'portal.example.test', PORTAL_RELEASE: 'abcdef012345-0123456789ab' },
    });
    expect(r.status, r.stderr).toBe(0);
    const services = (
      r.config as unknown as { services: Record<string, { environment?: Record<string, string> }> }
    ).services;
    const pick = (env: Record<string, string>, re: RegExp): Record<string, string> =>
      Object.fromEntries(Object.entries(env).filter(([k]) => re.test(k)));
    return {
      finance: pick(services.finance!.environment!, /^FINANCE_PORTAL_/),
      // The package is off in the first public release (PORTAL_PACKAGE_ENABLED=0 and an edge
      // refusal); this acceptance measures it as the later release that turns it on would run it.
      portal: {
        ...pick(
          services['portal-web']!.environment!,
          /^PORTAL_(PACKAGE|PDF)_|^PORTAL_TRUST_PROXY$/,
        ),
        PORTAL_PACKAGE_ENABLED: '1' as string,
      },
    };
  } finally {
    rmSync(secrets, { recursive: true, force: true });
  }
}

/** The public edge's Caddyfile: Caddyfile.qr's global options verbatim + the portal site. */
function edgeCaddyfile() {
  const qr = readFileSync(join(repoRoot, 'deploy/prod/Caddyfile.qr'), 'utf8');
  const start = qr.search(/^\{$/m);
  const global = qr.slice(start, qr.indexOf('\n}\n', start) + 3);
  expect(global).toMatch(/write 30s/);
  const site = readFileSync(join(repoRoot, 'deploy/prod/sites/portal.caddy'), 'utf8');
  const acme = '\ttls {\n\t\tissuer acme\n\t}\n';
  expect(site.split(acme)).toHaveLength(2); // the only changes below
  // Without the first release's refusal of the package (see `portal` above).
  const block = /\n\t@package path [^\n]*\n\thandle @package \{\n(?:\t\t[^\n]*\n)*\t\}\n/;
  expect(site).toMatch(block);
  return {
    text: `${global}\n${site.replace(acme, '\ttls internal\n').replace(block, '\n')}`,
    global,
  };
}

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

describe.skipIf(!enabled)(
  'doc 064 A1 acceptance: a real invoice package through the PROD edge configuration',
  { timeout: 300_000 },
  () => {
    let f: FinanceTestApp;
    let portal: ChildProcess;
    const portalLog: string[] = [];
    const work = mkdtempSync(join(tmpdir(), 'ayvo-a1-'));
    const caddyName = `ayvo-a1-acceptance-${randomBytes(3).toString('hex')}`;
    let ca: Buffer;
    let portalContainer = '';
    const proxies: Server[] = [];
    let cfg: ReturnType<typeof prodConfig>;
    const issued = new Map<string, string>(); // number → PDF sha256
    const issuedIn = new Map<string, Map<string, string>>(); // month → number → sha256
    const report: Record<string, unknown> = {};
    let session = '';

    /** One HTTPS request through the edge (SNI = the portal host), trusting this run's CA. */
    function call(
      method: 'GET' | 'POST',
      path: string,
      headers: Record<string, string>,
      body?: string,
    ) {
      return new Promise<{ status: number; headers: Headers; text: string }>((ok, fail) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port: EDGE_PORT,
            servername: DOMAIN,
            method,
            path,
            ca,
            headers: { host: `${DOMAIN}:${EDGE_PORT}`, ...headers },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const h = new Headers();
              for (const [k, v] of Object.entries(res.headers))
                for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v])
                  h.append(k, one);
              ok({
                status: res.statusCode ?? 0,
                headers: h,
                text: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on('error', fail);
        req.end(body);
      });
    }
    const jar = new Map<string, string>();
    const keep = (h: Headers) => {
      for (const line of h.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const name = pair!.slice(0, pair!.indexOf('='));
        const value = pair!.slice(pair!.indexOf('=') + 1);
        if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name);
        else jar.set(name, value);
      }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    async function post(path: string, body: unknown) {
      const payload = JSON.stringify(body);
      const res = await call(
        'POST',
        path,
        {
          cookie: cookie(),
          origin: BASE,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
        payload,
      );
      keep(res.headers);
      return res;
    }

    /**
     * The package through the edge by curl at `rate` B/s (0 = unlimited). Asynchronous: the core
     * and Finance run in this process and must keep serving while curl waits.
     */
    let downloads = 0;
    async function download(from: string, to: string, rate: number, maxTimeS?: number) {
      const n = ++downloads;
      const out = join(work, `package-${n}.zip`);
      const started = Date.now();
      const child = spawn(
        'curl',
        [
          '-sS',
          '--resolve',
          `${DOMAIN}:${EDGE_PORT}:127.0.0.1`,
          '--cacert',
          join(work, 'root.crt'),
          '-H',
          `cookie: __Host-ayvo_portal=${session}`,
          ...(rate ? ['--limit-rate', String(rate)] : []),
          ...(maxTimeS ? ['--max-time', String(maxTimeS)] : []),
          ...(process.env.PORTAL_A1_HTTP1 ? ['--http1.1'] : []),
          '-D',
          join(work, `headers-${n}.txt`),
          '-o',
          out,
          '-w',
          '%{http_code} %{size_download} %{time_starttransfer} %{time_total}',
          `${BASE}/invoices/package?from=${from}&to=${to}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      const exit = await new Promise<number | null>((r) => child.on('exit', r));
      const res = { status: exit, stdout, stderr };
      const [code, size, ttfb, total] = res.stdout.trim().split(' ');
      const read = (f: string) => {
        try {
          return readFileSync(f);
        } catch {
          return Buffer.alloc(0);
        }
      };
      const headers = read(join(work, `headers-${n}.txt`)).toString();
      return {
        curlExit: res.status,
        curlError: res.stderr.trim(),
        status: Number(code),
        bytes: Number(size),
        contentLength: Number(/^content-length:\s*(\d+)/im.exec(headers)?.[1] ?? NaN),
        location: /^location:\s*(\S+)/im.exec(headers)?.[1] ?? null,
        firstByteS: Number(ttfb),
        totalS: Number(total),
        wallS: (Date.now() - started) / 1000,
        zip: read(out),
      };
    }

    beforeAll(async () => {
      cfg = prodConfig();
      report.prodLimits = { ...cfg, finance: { ...cfg.finance } };
      // Comparison only (never the acceptance): another package size, e.g. the former 20 MiB.
      if (process.env.PORTAL_A1_PACKAGE_BYTES) {
        cfg.finance.FINANCE_PORTAL_PACKAGE_MAX_BYTES = process.env.PORTAL_A1_PACKAGE_BYTES;
        report.comparisonPackageBytes = Number(process.env.PORTAL_A1_PACKAGE_BYTES);
      }
      f = await createFinanceTestApp({
        core: { redis: 'real' },
        coreEnv: {
          AUTH_PROVIDER: 'local',
          AUTH_MAIL_DRIVER: 'memory',
          PORTAL_PUBLIC_ORIGIN: BASE,
          PORTAL_SERVICE_TOKEN_SHA256: sha(coreToken),
        },
        finance: { PORTAL_FINANCE_TOKEN_SHA256: sha(financeToken), ...cfg.finance },
      });
      await f.app.listen(0, '127.0.0.1');
      const corePort = (f.core.app.getHttpServer().address() as AddressInfo).port;
      const financePort = (f.app.getHttpServer().address() as AddressInfo).port;
      const coreUrl = `http://127.0.0.1:${corePort}`;

      // The edge: a real Caddy, published on loopback only, reaching portal-web on the host.
      const gateway = docker(
        'network',
        'inspect',
        'bridge',
        '-f',
        '{{(index .IPAM.Config 0).Gateway}}',
      ).stdout.trim();
      expect(gateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const caddyfile = edgeCaddyfile();
      report.edgeGlobalOptions = caddyfile.global;
      writeFileSync(join(work, 'Caddyfile'), caddyfile.text);
      const run = docker(
        'run',
        '-d',
        '--name',
        caddyName,
        '--add-host',
        `portal-web:${gateway}`,
        '-p',
        `127.0.0.1:${EDGE_PORT}:443`,
        '-e',
        `PORTAL_DOMAIN=${DOMAIN}`,
        '-e',
        'ACME_EMAIL=acceptance@ayvo.test',
        '-v',
        `${join(work, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        CADDY_IMAGE,
      );
      expect(run.status, run.stderr).toBe(0);
      report.caddy = docker('exec', caddyName, 'caddy', 'version').stdout.trim();
      report.caddyImage = {
        ref: CADDY_IMAGE,
        id: docker('image', 'inspect', '--format', '{{.Id}}', CADDY_IMAGE).stdout.trim(),
        repoDigests: docker(
          'image',
          'inspect',
          '--format',
          '{{json .RepoDigests}}',
          CADDY_IMAGE,
        ).stdout.trim(),
      };
      report.source = {
        revision: spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf8',
        }).stdout.trim(),
        command:
          'PORTAL_A1_ACCEPTANCE=1 PORTAL_A1_REPORT=<file> pnpm --filter @ayvo/api exec vitest run test/portal-a1-acceptance.e2e.test.ts',
      };

      /** A plain TCP forward on the Docker gateway to a unit on loopback (for the container). */
      const forward = async (target: number) => {
        const srv = createServer((c) => {
          const u = connect(target, '127.0.0.1');
          c.pipe(u);
          u.pipe(c);
          c.on('error', () => u.destroy());
          u.on('error', () => c.destroy());
        });
        await new Promise<void>((ok) => srv.listen(0, gateway, ok));
        proxies.push(srv);
        return (srv.address() as AddressInfo).port;
      };
      if (PORTAL_IMAGE) {
        const [cp, fp] = [await forward(corePort), await forward(financePort)];
        portalContainer = `${caddyName}-portal`;
        const env = {
          APP_ENV: 'production',
          PORTAL_PUBLIC_ORIGIN: BASE,
          CORE_INTERNAL_URL: `http://${gateway}:${cp}`,
          FINANCE_INTERNAL_URL: `http://${gateway}:${fp}`,
          PORTAL_CORE_TOKEN: coreToken,
          PORTAL_FINANCE_TOKEN: financeToken,
          ...cfg.portal,
        };
        const started = docker(
          'run',
          '-d',
          '--name',
          portalContainer,
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--memory',
          '256m',
          '--cpus',
          '0.5',
          '--pids-limit',
          '128',
          '-p',
          `${gateway}:${PORTAL_PORT}:3200`,
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          PORTAL_IMAGE,
        );
        expect(started.status, started.stderr).toBe(0);
        report.portalImage = {
          ref: PORTAL_IMAGE,
          id: docker('image', 'inspect', '--format', '{{.Id}}', PORTAL_IMAGE).stdout.trim(),
        };
      }
      portal = spawn(
        PORTAL_IMAGE ? 'sleep' : resolve(portalDir, 'node_modules/.bin/next'),
        PORTAL_IMAGE ? ['3600'] : ['start', '--hostname', gateway, '--port', String(PORTAL_PORT)],
        {
          cwd: portalDir,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            APP_ENV: 'production',
            PORTAL_PUBLIC_ORIGIN: BASE,
            CORE_INTERNAL_URL: coreUrl,
            FINANCE_INTERNAL_URL: `http://127.0.0.1:${financePort}`,
            PORTAL_CORE_TOKEN: coreToken,
            PORTAL_FINANCE_TOKEN: financeToken,
            ...cfg.portal,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      portal.stdout!.on('data', (c) => portalLog.push(String(c)));
      portal.stderr!.on('data', (c) => portalLog.push(String(c)));

      // Caddy's own CA (made on the first TLS use), then wait for the page through the edge.
      for (let i = 0; ; i++) {
        const root = docker('exec', caddyName, 'cat', '/data/caddy/pki/authorities/local/root.crt');
        if (root.status === 0 && root.stdout.includes('BEGIN CERTIFICATE')) {
          ca = Buffer.from(root.stdout);
          writeFileSync(join(work, 'root.crt'), ca);
          const up = await call('GET', '/login', {}).then(
            (r) => r.status === 200,
            () => false,
          );
          if (up) break;
        } else {
          // The first handshake makes Caddy issue its internal certificate.
          spawnSync('curl', [
            '-sk',
            '--resolve',
            `${DOMAIN}:${EDGE_PORT}:127.0.0.1`,
            `${BASE}/login`,
          ]);
        }
        if (i > 300)
          throw new Error(
            `edge or portal-web did not start:\n${docker('logs', caddyName).stderr}\n${portalLog.join('')}`,
          );
        await new Promise((r) => setTimeout(r, 200));
      }

      // Synthetic data: one payer, one hotel, the most invoices Finance packs, PDFs filling the cap.
      const runId = randomUUID().slice(0, 4);
      const p = await payer(f, `Plátce A1 ${runId}`);
      const h = await hotel(f, `Hotel A1 ${runId} (syntetický)`);
      const a = await agreement(f, p.id, h.id);
      const count = Number(cfg.finance.FINANCE_PORTAL_PACKAGE_MAX_INVOICES ?? 60);
      const cap = Number(cfg.finance.FINANCE_PORTAL_PACKAGE_MAX_BYTES);
      // Per entry the STORE ZIP adds ~ 2 × (30/46 + name) bytes; 64 KiB keeps the manifest in.
      const pdfSize = Math.floor((cap - 64 * 1024) / count);
      const months: string[] = [];
      for (let m = 0; m < 12; m++) {
        const d = new Date(Date.UTC(2025, 9 + m, 1));
        months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      }
      for (let i = 0; i < count; i++) {
        const body = Buffer.concat([
          Buffer.from(`%PDF-1.4\n% synthetic A1 acceptance invoice ${i}\n`),
          randomBytes(pdfSize - 64),
        ]).subarray(0, pdfSize - 6);
        const pdf = Buffer.concat([body, Buffer.from('\n%%EOF')]);
        const inv = await invoice(f, [a.code], months[i % 12]!, pdf);
        issued.set(inv.number, inv.pdfSha256);
        if (!issuedIn.has(months[i % 12]!)) issuedIn.set(months[i % 12]!, new Map());
        issuedIn.get(months[i % 12]!)!.set(inv.number, inv.pdfSha256);
      }
      // Beyond the main period: three large invoices of the next month, so a half-year period
      // holds fewer invoices than the cap allows but more bytes than it (refused while reading).
      const over = (() => {
        const d = new Date(Date.UTC(2025, 9 + 12, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      })();
      for (let i = 0; i < 3; i++)
        await invoice(
          f,
          [a.code],
          over,
          Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(6 * 1024 * 1024)]),
        );
      report.invoices = {
        count,
        pdfBytes: pdfSize,
        months: [months[0], months[11]],
        overLimitPeriod: [months[6], over],
        smallPeriod: months[0],
      };

      // The account through Finance and portal-web (memory mail): activation, then a session.
      const email = `a1-${runId}@ayvo.test`;
      const g = await f.post('/api/admin/finance/portal-grants').send({
        requestId: randomUUID(),
        payerCustomerId: p.id,
        email,
        displayName: 'Recepce A1 (syntetická)',
        hotelIds: [h.id],
        reason: 'Akceptace A1 (syntetická)',
      });
      expect(g.status, JSON.stringify(g.body)).toBe(201);
      expect((g.body as FinancePortalGrantResult).grant.id).toBeTruthy();
      const tokens = f.core.app.get(NativeTokensService);
      await tokens.deliverPending();
      const mail = tokens.deliveriesForTest().filter((m) => m.to === email);
      expect(mail).toHaveLength(1);
      const token = new URLSearchParams(new URL(mail[0]!.url).hash.slice(1)).get('token')!;
      expect((await call('GET', '/activate', {})).status).toBe(200);
      const step = await post('/auth/activate', { token, password: PASSWORD });
      expect(step.status, step.text).toBe(200);
      const { setupKey } = JSON.parse(step.text) as { setupKey: string };
      const done = await post('/auth/mfa', { code: otp(setupKey) });
      expect(done.status, done.text).toBe(200);
      session = jar.get('__Host-ayvo_portal') ?? '';
      expect(session).toBeTruthy();
    }, 300_000);

    afterAll(async () => {
      portal?.kill('SIGTERM');
      docker('rm', '-f', caddyName);
      if (portalContainer) {
        report.portalContainerLog = docker('logs', '--tail', '20', portalContainer).stderr.slice(
          -2000,
        );
        docker('rm', '-f', portalContainer);
      }
      for (const p of proxies) p.close();
      await f?.close();
      if (process.env.PORTAL_A1_REPORT)
        writeFileSync(process.env.PORTAL_A1_REPORT, `${JSON.stringify(report, null, 2)}\n`);
      rmSync(work, { recursive: true, force: true });
    });

    const check = (
      r: Awaited<ReturnType<typeof download>>,
      label: string,
      expected: Map<string, string> = issued,
    ) => {
      const { zip, ...measured } = r;
      report[label] = measured;
      expect(r.curlExit, `${label}: ${r.curlError}`).toBe(0);
      expect(r.status).toBe(200);
      expect(r.bytes).toBe(r.contentLength);
      expect(r.bytes).toBeLessThanOrEqual(Number(cfg.finance.FINANCE_PORTAL_PACKAGE_MAX_BYTES));
      const files = unzip(zip);
      const pdfs = [...files].filter(([n]) => n.startsWith('faktury/'));
      expect(pdfs).toHaveLength(expected.size);
      expect(pdfs.map(([, b]) => sha(b)).sort()).toEqual([...expected.values()].sort());
      const manifest = files.get('manifest.csv')?.toString() ?? '';
      for (const number of expected.keys()) expect(manifest).toContain(number);
      report[`${label}-zipSha256`] = sha(zip);
      report[`${label}-pdfs`] = { count: pdfs.length, sha256: pdfs.map(([, b]) => sha(b)).sort() };
      report[`${label}-manifestLines`] = manifest.trim().split('\n').length;
    };

    it('the session works through the edge: the invoice list', async () => {
      const t0 = Date.now();
      const list = await call('GET', '/invoices', { cookie: `__Host-ayvo_portal=${session}` });
      report.list = { status: list.status, ms: Date.now() - t0 };
      expect(list.status).toBe(200);
      expect([...issued.keys()].some((n) => list.text.includes(n))).toBe(true);
    });

    it('unlimited client: Finance builds the full package; its time to the first byte', async () => {
      const m = (report.invoices as { months: string[] }).months;
      check(await download(m[0]!, m[1]!, 0), 'unlimited');
    });

    it('8 Mbit/s client: the whole ZIP arrives intact, within Finance’s deadline and below the edge’s 30 s', async () => {
      const m = (report.invoices as { months: string[] }).months;
      const r = await download(m[0]!, m[1]!, RATE);
      check(r, 'limited-8mbit');
      // The limit was in force (the transfer took at least ~its size / rate) …
      expect(r.totalS).toBeGreaterThan((r.bytes / RATE) * 0.9);
      // … and the whole transfer ended within Finance's own deadline (not saved by buffers), so
      // also within portal-web's (25 s) and the edge's write (30 s).
      expect(r.totalS * 1000).toBeLessThan(Number(cfg.finance.FINANCE_PORTAL_PACKAGE_TIMEOUT_MS));
      expect(Number(cfg.finance.FINANCE_PORTAL_PACKAGE_TIMEOUT_MS)).toBeLessThan(
        Number(cfg.portal.PORTAL_PACKAGE_DEADLINE_MS),
      );
    });

    const inv = () =>
      report.invoices as { overLimitPeriod: string[]; smallPeriod: string; months: string[] };
    /** The small package (one month) completes at 8 Mbit/s — retried briefly while a slot frees. */
    async function smallPackage(label: string) {
      const m = inv().smallPeriod;
      const started = Date.now();
      for (;;) {
        const r = await download(m, m, RATE);
        if (r.status === 200 || Date.now() - started > 10_000) {
          check(r, label, issuedIn.get(m)!);
          return { ...r, afterS: (Date.now() - started) / 1000 };
        }
        report[`${label}-retry`] = r.location;
        await new Promise((ok) => setTimeout(ok, 500));
      }
    }

    it('over the cap: refused before the first byte of a ZIP, with its reason', async () => {
      const [from, to] = inv().overLimitPeriod;
      const r = await download(from!, to!, RATE);
      const { zip, ...measured } = r;
      report['over-limit'] = measured;
      expect(r.status).toBe(303);
      expect(r.location).toMatch(/balicek=PACKAGE_TOO_LARGE/);
      expect(r.bytes).toBe(0);
      expect(zip.length).toBe(0);
      expect(r.totalS).toBeLessThan(5);
    });

    it('a client that leaves mid-transfer: the transfer stops; a smaller ZIP then completes', async () => {
      const m = inv().months;
      const leaving = download(m[0]!, m[1]!, 50_000, 4); // 0.4 Mbit/s, gone after 4 s
      await new Promise((ok) => setTimeout(ok, 1500));
      // Measured, not required: Finance's one package slot is free once its bytes have left it
      // (the rest is in portal-web's, the kernel's and the edge's buffers).
      const meanwhile = await download(inv().smallPeriod, inv().smallPeriod, RATE);
      report['while-in-transfer'] = { status: meanwhile.status, location: meanwhile.location };
      const gone = await leaving;
      const { zip, ...measured } = gone;
      report['client-left'] = measured;
      expect(gone.curlExit).toBe(28); // curl's own --max-time: the client went away
      expect(zip.length).toBeLessThan(gone.contentLength);
      expect(() => unzip(zip)).toThrow();
      const next = await smallPackage('after-client-left');
      report['after-client-left-s'] = next.afterS;
    });

    it('an extremely slow client that stays: never a whole-looking ZIP; a smaller ZIP completes after', async () => {
      const m = inv().months;
      const slow = await download(m[0]!, m[1]!, 100_000); // 0.8 Mbit/s: 16 MiB would need ~170 s
      const { zip, ...measured } = slow;
      report[`slow-client${process.env.PORTAL_A1_HTTP1 ? '-http1.1' : ''}`] = measured;
      if (slow.bytes === slow.contentLength) {
        // Delivered whole after all (no unit or edge cut it): then it must be intact.
        check(slow, 'slow-client-whole');
      } else {
        expect(slow.curlExit).not.toBe(0);
        expect(() => unzip(zip)).toThrow();
      }
      const next = await smallPackage('after-slow-client');
      report['after-slow-client-s'] = next.afterS;
    });

    /** RSS in KiB of a process and all its descendants (/proc), 0 when gone. */
    function treeRssKiB(pid: number): number {
      let total = 0;
      const visit = (p: number) => {
        try {
          const status = readFileSync(`/proc/${p}/status`, 'utf8');
          total += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
          const kids = readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim();
          for (const k of kids ? kids.split(/\s+/) : []) visit(Number(k));
        } catch {
          // gone
        }
      };
      visit(pid);
      return total;
    }
    const tcpMemPages = () =>
      Number(/^TCP:.* mem (\d+)/m.exec(readFileSync('/proc/net/sockstat', 'utf8'))?.[1] ?? 0);
    const cgroup = (name: string, file: string) =>
      readFileSync(
        `/sys/fs/cgroup/system.slice/docker-${docker('inspect', '-f', '{{.Id}}', name).stdout.trim()}.scope/${file}`,
        'utf8',
      );
    const caddyMemMiB = () => Number(cgroup(caddyName, 'memory.current')) / 1024 / 1024;
    /** The portal container: its whole cgroup memory and the socket part of it (MiB). */
    const portalCgroup = () => {
      const stat = cgroup(portalContainer, 'memory.stat');
      const field = (k: string) =>
        Number(new RegExp(`^${k} (\\d+)`, 'm').exec(stat)?.[1] ?? 0) / 1024 / 1024;
      return {
        currentMiB: Number(cgroup(portalContainer, 'memory.current')) / 1024 / 1024,
        anonMiB: field('anon'),
        sockMiB: field('sock'),
      };
    };

    const parked = Number(process.env.PORTAL_A1_PARKED ?? 0);
    it.runIf(parked > 0)(
      `measured: ${parked} slow clients started 1.5 s apart (0.8 Mbit/s, gone after 60 s) — bounded, memory per unit, then recovery`,
      async () => {
        const m = inv().months;
        const sample = () => ({
          atS: 0,
          portalWebMiB: portalContainer
            ? portalCgroup().currentMiB
            : treeRssKiB(portal.pid!) / 1024,
          portalAnonMiB: portalContainer ? portalCgroup().anonMiB : NaN,
          portalSockMiB: portalContainer ? portalCgroup().sockMiB : NaN,
          coreAndFinanceMiB: process.memoryUsage().rss / 1024 / 1024,
          caddyMiB: (() => {
            try {
              return caddyMemMiB();
            } catch {
              return NaN;
            }
          })(),
          tcpMiB: (tcpMemPages() * 4096) / 1024 / 1024,
        });
        const before = sample();
        const started = Date.now();
        // Started one after another (1.5 s apart): concurrent starts are refused by Finance's one
        // package slot (busy while it builds), a staggered start after the bytes left is not.
        const clients: ReturnType<typeof download>[] = [];
        for (let i = 0; i < parked; i++) {
          clients.push(download(m[0]!, m[1]!, 100_000, 60));
          await new Promise((ok) => setTimeout(ok, 1500));
        }
        const samples: ReturnType<typeof sample>[] = [];
        const timer = setInterval(
          () => samples.push({ ...sample(), atS: (Date.now() - started) / 1000 }),
          2000,
        );
        const results = await Promise.all(clients);
        clearInterval(timer);
        await new Promise((ok) => setTimeout(ok, 5000));
        const after = sample();
        const peak = (k: keyof ReturnType<typeof sample>) =>
          Math.max(...samples.map((x) => x[k] as number));
        report[`parked-${parked}${process.env.PORTAL_A1_HTTP1 ? '-http1.1' : ''}`] = {
          before,
          peak: {
            portalWebMiB: peak('portalWebMiB'),
            portalAnonMiB: peak('portalAnonMiB'),
            portalSockMiB: peak('portalSockMiB'),
            coreAndFinanceMiB: peak('coreAndFinanceMiB'),
            caddyMiB: peak('caddyMiB'),
            tcpMiB: peak('tcpMiB'),
          },
          after,
          clients: results.map((r) => ({
            exit: r.curlExit,
            status: r.status,
            bytes: r.bytes,
            location: r.location,
          })),
          samples,
        };
        // Bounded today by portal-web's file slots (PORTAL_PDF_MAX_IN_FLIGHT, held until the body is
        // pulled into the socket) and Finance's one package at a time: a few are served, the others
        // are refused before any byte; none got a whole-looking ZIP in 60 s at 0.8 Mbit/s.
        const served = results.filter((r) => r.status === 200);
        const refused = results.filter((r) => r.status !== 200);
        expect(served.length).toBeGreaterThan(0);
        expect(served.length).toBeLessThanOrEqual(
          Number(cfg.portal.PORTAL_PDF_MAX_IN_FLIGHT ?? 2) + 1,
        );
        for (const r of served) expect(() => unzip(r.zip)).toThrow();
        for (const r of refused) {
          expect(r.status).toBe(303);
          expect(r.location).toMatch(/balicek=PACKAGE_BUSY/);
          expect(r.bytes).toBe(0);
        }
        // After they left: a normal package completes.
        await smallPackage(`after-parked-${parked}`);
      },
      240_000,
    );

    const extreme = Number(process.env.PORTAL_A1_EXTREME_BPS ?? 0);
    it.runIf(extreme > 0)(
      `measured: how long one client at ${extreme} B/s keeps a package transfer alive (nothing cuts it?)`,
      async () => {
        const m = inv().months;
        const r = await download(m[0]!, m[1]!, extreme, 900);
        const { zip, ...measured } = r;
        report[`extreme-${extreme}${process.env.PORTAL_A1_HTTP1 ? '-http1.1' : ''}`] = {
          ...measured,
          zipBytes: zip.length,
        };
        expect(r.status).toBe(200);
        await smallPackage(`after-extreme-${extreme}`);
      },
      1_000_000,
    );
  },
);
