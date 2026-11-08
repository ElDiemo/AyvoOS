import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FinancePortalGrantResult } from '@ayvo/types';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import {
  createFinanceTestApp,
  TEST_SESSION_COOKIE,
  type FinanceTestApp,
} from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { hasDatabase, TEST_APP_ORIGIN } from './support/test-app.js';

/**
 * The hotel portal walk of ADR 0045 §11 through the REAL units (review 5818694161): the core and
 * Finance as in the other e2e tests (real HTTP, real DB roles, real Redis rate limits), and the
 * BUILT portal-web (`next start`, apps/portal) between them and the "browser" — only portal-web's
 * public routes and pages are called for the hotel users. Two synthetic accounts with different
 * grants, issued through Finance; activation, sign-in, own PDF, a foreign one refused, a grant
 * replaced and revoked, sign-out, Finance down. Screenshots at 390 / 1440 px go to
 * PORTAL_WEB_WALK_SHOTS when set.
 *
 * As on DEV (ADR 0045 §7), the "browser" reaches portal-web only through a TLS edge on its own
 * https origin (a self-signed certificate made per run with openssl, as test/support/fake-rb.ts
 * does) that appends X-Forwarded-For; portal-web trusts that one entry (PORTAL_TRUST_PROXY=1).
 *
 * Opt-in (needs `pnpm --filter @ayvo/portal build` first):
 *   PORTAL_WEB_WALK=1 pnpm --filter @ayvo/api exec vitest run test/portal-web-walk.e2e.test.ts
 */
const enabled = hasDatabase && process.env.PORTAL_WEB_WALK === '1';
/** portal-web itself (loopback) and the edge in front of it (the portal's public origin). */
const PORT = 3400;
const EDGE_PORT = 3443;
const BASE = `https://localhost:${EDGE_PORT}`;
const PASSWORD = 'Dlouhe portalove heslo AYVO 2026';
const coreToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const portalDir = resolve(import.meta.dirname, '../../portal');
const otp = (secret: string, offsetSteps = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });

/** A certificate for localhost, made per run (never a real one). */
function edgeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-portal-walk-edge-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      'edge.key',
      '-out',
      'edge.crt',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  return { key: readFileSync(join(dir, 'edge.key')), cert: readFileSync(join(dir, 'edge.crt')) };
}

/** The edge: TLS on the public origin, everything forwarded to portal-web with X-Forwarded-For. */
function startEdge(tls: { key: Buffer; cert: Buffer }): Promise<Server> {
  const server = createHttpsServer(tls, (req, res) => {
    const forwarded = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
      .filter(Boolean)
      .join(', ');
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-for': forwarded, 'x-forwarded-proto': 'https' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return new Promise((r) => server.listen(EDGE_PORT, '127.0.0.1', () => r(server)));
}

let edgeCa: Buffer;
/** One HTTPS request to the edge, trusting only this run's certificate. */
function call(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: string,
) {
  return new Promise<Response>((resolveCall, reject) => {
    const req = httpsRequest(
      { host: 'localhost', port: EDGE_PORT, method, path, headers, ca: edgeCa },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, one);
          const status = res.statusCode ?? 0;
          const payload = [204, 304].includes(status) ? null : Buffer.concat(chunks);
          resolveCall(new Response(payload, { status, headers: h }));
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** A browser stand-in for one hotel user: its own cookie jar, Origin on every POST. */
class Browser {
  readonly jar = new Map<string, string>();
  get session() {
    return this.jar.get('__Host-ayvo_portal') ?? null;
  }
  private keep(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, value] = [
        pair!.slice(0, pair!.indexOf('=')),
        pair!.slice(pair!.indexOf('=') + 1),
      ];
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async get(path: string) {
    return this.keep(await call('GET', path, { cookie: this.cookie() }));
  }
  async post(path: string, body?: unknown) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return this.keep(
      await call(
        'POST',
        path,
        {
          cookie: this.cookie(),
          origin: BASE,
          'sec-fetch-site': 'same-origin',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }),
        },
        payload,
      ),
    );
  }
}

describe.skipIf(!enabled)(
  'hotel portal walk: portal-web against the real core and Finance',
  { timeout: 120_000 },
  () => {
    let f: FinanceTestApp;
    let portal: ChildProcess;
    let edge: Server;
    const portalLog: string[] = [];
    let financeClosed = false;
    const d = {} as {
      A: { id: string };
      B: { id: string };
      H1: { id: string; name: string };
      H2: { id: string; name: string };
      H3: { id: string; name: string };
      A1: { id: string; number: string; pdfSha256: string };
      A2: { id: string; number: string; pdfSha256: string };
      B1: { id: string; number: string; pdfSha256: string };
    };
    const users = {} as Record<
      'a' | 'b',
      { email: string; grantId: string; secret: string; recovery: string[]; browser: Browser }
    >;
    /**
     * Screenshots of one page at 390 / 1440 px in Chromium with this session, taken now (the
     * session may be ended later in the walk); any CSP violation or page error fails the step.
     * Only when PORTAL_WEB_WALK_SHOTS names an output directory.
     */
    async function shoot(name: string, session: string | null, path: string) {
      const out = process.env.PORTAL_WEB_WALK_SHOTS;
      if (!out) return;
      const run = spawn(
        process.execPath,
        [
          'e2e/real-snapshots.mjs',
          JSON.stringify({ base: BASE, out, shots: [{ name, session, path }] }),
        ],
        { cwd: portalDir, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const log: string[] = [];
      run.stdout!.on('data', (c) => log.push(String(c)));
      run.stderr!.on('data', (c) => log.push(String(c)));
      const code = await new Promise<number | null>((r) => run.on('exit', r));
      shotLog.push(log.join(''));
      expect(code, log.join('')).toBe(0);
    }
    const shotLog: string[] = [];

    const coreAdmin = () => request(f.core.app.getHttpServer());

    async function invitationOf(email: string) {
      const tokens = f.core.app.get(NativeTokensService);
      await tokens.deliverPending();
      const sent = tokens.deliveriesForTest().filter((m) => m.to === email);
      expect(sent).toHaveLength(1);
      const url = new URL(sent[0]!.url);
      expect(url.origin + url.pathname).toBe(`${BASE}/activate`);
      return new URLSearchParams(url.hash.slice(1)).get('token')!;
    }

    async function grant(payerId: string, hotelIds: string[], who: string) {
      const email = `${who}-${randomUUID().slice(0, 8)}@ayvo.test`;
      const res = await f.post('/api/admin/finance/portal-grants').send({
        requestId: randomUUID(),
        payerCustomerId: payerId,
        email,
        displayName: `Recepce ${who.toUpperCase()} (syntetická)`,
        hotelIds,
        reason: 'Průchod portálem (syntetický)',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return { email, grantId: (res.body as FinancePortalGrantResult).grant.id };
    }

    /** Activation in portal-web: the page, password, TOTP enrolment, recovery codes, a session. */
    async function activate(who: 'a' | 'b', token: string) {
      const b = new Browser();
      const page = await b.get('/activate');
      expect(page.status).toBe(200);
      const step = await b.post('/auth/activate', { token, password: PASSWORD });
      const stepBody = (await step.json()) as { step: string; qrDataUrl: string; setupKey: string };
      expect(step.status, JSON.stringify(stepBody)).toBe(200);
      expect(stepBody.step).toBe('ENROLL_MFA');
      expect(stepBody.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(b.jar.has('__Host-ayvo_portal_pre')).toBe(true);
      const done = await b.post('/auth/mfa', { code: otp(stepBody.setupKey) });
      const doneBody = (await done.json()) as { step: string; recoveryCodes: string[] };
      expect(done.status, JSON.stringify(doneBody)).toBe(200);
      expect(doneBody.step).toBe('DONE');
      expect(doneBody.recoveryCodes.length).toBeGreaterThan(0);
      expect(b.session).toBeTruthy();
      expect(b.jar.has('__Host-ayvo_portal_pre')).toBe(false);
      users[who].secret = stepBody.setupKey;
      users[who].recovery = [...doneBody.recoveryCodes];
      users[who].browser = b;
    }

    /**
     * Sign-in in portal-web with the password, then the next TOTP step (the activation used the
     * current one, and a used step is never accepted again) or one of the account's recovery codes
     * (each once) — so the walk need not wait 30 s between sign-ins.
     */
    async function signIn(who: 'a' | 'b', factor: 'totp' | 'recovery') {
      const b = new Browser();
      const step = await b.post('/auth/password', { email: users[who].email, password: PASSWORD });
      expect(step.status, await step.clone().text()).toBe(200);
      const code = factor === 'totp' ? otp(users[who].secret, 1) : users[who].recovery.shift()!;
      const done = await b.post('/auth/mfa', { code });
      expect(done.status, await done.clone().text()).toBe(200);
      users[who].browser = b;
      return b;
    }

    const html = async (b: Browser, path: string) => {
      const res = await b.get(path);
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    };

    beforeAll(async () => {
      f = await createFinanceTestApp({
        core: { redis: 'real' },
        coreEnv: {
          AUTH_PROVIDER: 'local',
          AUTH_MAIL_DRIVER: 'memory',
          PORTAL_PUBLIC_ORIGIN: BASE,
          PORTAL_SERVICE_TOKEN_SHA256: sha(coreToken),
          // One address signs in several times in this walk.
          AUTH_RATE_LIMIT_LOGIN_MAX: '1000',
          AUTH_RATE_LIMIT_CALLBACK_MAX: '1000',
          AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '1000',
        },
        finance: { PORTAL_FINANCE_TOKEN_SHA256: sha(financeToken) },
      });
      await f.app.listen(0, '127.0.0.1');
      const corePort = (f.core.app.getHttpServer().address() as AddressInfo).port;
      const financePort = (f.app.getHttpServer().address() as AddressInfo).port;

      // Synthetic data (ADR §11 step 1): payer A with H1 and H2, payer B with H3; TEST invoices
      // A1 (H1), A2 (H1 + H2, a summary) and B1 (H3).
      const run = randomUUID().slice(0, 4);
      d.A = await payer(f, `Plátce A ${run}`);
      d.B = await payer(f, `Plátce B ${run}`);
      d.H1 = await hotel(f, `Hotel Jedna ${run} (syntetický)`);
      d.H2 = await hotel(f, `Hotel Dva ${run} (syntetický)`);
      d.H3 = await hotel(f, `Hotel Tři ${run} (syntetický)`);
      const a1 = await agreement(f, d.A.id, d.H1.id);
      const a2 = await agreement(f, d.A.id, d.H2.id);
      const b3 = await agreement(f, d.B.id, d.H3.id);
      const pdf = (n: string) =>
        Buffer.from(`%PDF-1.4\n% synthetic portal walk invoice ${n} ${randomUUID()}\n%%EOF\n`);
      d.A1 = await invoice(f, [a1.code], '2026-08', pdf('A1'));
      d.A2 = await invoice(f, [a1.code, a2.code], '2026-09', pdf('A2'));
      d.B1 = await invoice(f, [b3.code], '2026-09', pdf('B1'));

      const tls = edgeCertificate();
      edgeCa = tls.cert;
      edge = await startEdge(tls);
      portal = spawn(
        resolve(portalDir, 'node_modules/.bin/next'),
        ['start', '--hostname', '127.0.0.1', '--port', String(PORT)],
        {
          cwd: portalDir,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'production',
            APP_ENV: 'test',
            PORTAL_PUBLIC_ORIGIN: BASE,
            CORE_INTERNAL_URL: `http://127.0.0.1:${corePort}`,
            FINANCE_INTERNAL_URL: `http://127.0.0.1:${financePort}`,
            PORTAL_CORE_TOKEN: coreToken,
            PORTAL_FINANCE_TOKEN: financeToken,
            PORTAL_TRUST_PROXY: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      portal.stdout!.on('data', (c) => portalLog.push(String(c)));
      portal.stderr!.on('data', (c) => portalLog.push(String(c)));
      for (let i = 0; ; i++) {
        const up = await call('GET', '/login', {}).then(
          (r) => r.status === 200,
          () => false,
        );
        if (up) break;
        if (i > 200) throw new Error(`portal-web did not start:\n${portalLog.join('')}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    }, 120_000);

    afterAll(async () => {
      portal?.kill('SIGTERM');
      edge?.close();
      if (financeClosed) await f?.core.close();
      else await f?.close();
    });

    it('2. two invitations through Finance with different grants: {A: H1} and {B: H3}', async () => {
      users.a = {
        ...(await grant(d.A.id, [d.H1.id], 'portal-a')),
        secret: '',
        recovery: [],
        browser: null!,
      };
      users.b = {
        ...(await grant(d.B.id, [d.H3.id], 'portal-b')),
        secret: '',
        recovery: [],
        browser: null!,
      };
      await activate('a', await invitationOf(users.a.email));
      await activate('b', await invitationOf(users.b.email));
    });

    it('3. user A signs in again (password + TOTP), sees H1 only and A1 only, and downloads its own PDF', async () => {
      // Sign out of the activation session, then sign in with password + TOTP.
      expect((await users.a.browser.post('/auth/logout')).status).toBe(204);
      const a = await signIn('a', 'totp');
      const home = await html(a, '/');
      expect(home.status).toBe(200);
      expect(home.text).toContain(d.H1.name);
      expect(home.text).not.toContain(d.H2.name);
      expect(home.text).not.toContain(d.H3.name);
      const list = await html(a, '/invoices');
      expect(list.text).toContain(d.A1.number);
      expect(list.text).not.toContain(d.A2.number);
      expect(list.text).not.toContain(d.B1.number);
      expect(list.text).toContain('TESTOVACÍ');
      const detail = await html(a, `/invoices/${d.A1.id}`);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('Neuhrazená');
      const file = await a.get(`/invoices/${d.A1.id}/pdf`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('application/pdf');
      expect(file.headers.get('cache-control')).toBe('private, no-store');
      expect(file.headers.get('content-disposition')).toBe(
        `attachment; filename="${d.A1.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`,
      );
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(d.A1.pdfSha256);
      // A2 also covers H2, which A may not see: not listed, and its detail and PDF are not found.
      expect((await a.get(`/invoices/${d.A2.id}/pdf`)).status).toBe(404);
      await shoot('a-hotels', a.session, '/');
      await shoot('a-invoices', a.session, '/invoices');
      await shoot('a-invoice-A1', a.session, `/invoices/${d.A1.id}`);
    });

    it('4. user B sees H3 and B1 only; A’s invoice, its PDF and A’s hotel are not found for B', async () => {
      const b = users.b.browser;
      const home = await html(b, '/');
      expect(home.text).toContain(d.H3.name);
      expect(home.text).not.toContain(d.H1.name);
      const list = await html(b, '/invoices');
      expect(list.text).toContain(d.B1.number);
      expect(list.text).not.toContain(d.A1.number);
      expect((await b.get(`/invoices/${d.A1.id}/pdf`)).status).toBe(404);
      const foreign = await html(b, `/invoices/${d.A1.id}`);
      expect(foreign.status).toBe(404);
      expect(foreign.text).not.toContain(d.A1.number);
      expect((await html(b, `/hotels/${d.H1.id}`)).status).toBe(404);
      const own = await b.get(`/invoices/${d.B1.id}/pdf`);
      expect(
        createHash('sha256')
          .update(Buffer.from(await own.arrayBuffer()))
          .digest('hex'),
      ).toBe(d.B1.pdfSha256);
      await shoot('b-hotels', b.session, '/');
      await shoot('b-invoices', b.session, '/invoices');
      await shoot('b-foreign-invoice', b.session, `/invoices/${d.A1.id}`);
    });

    it('5a. the ADMIN replaces A’s grant with {H1, H2} through Finance: A2 appears on A’s next request', async () => {
      const res = await f.post(`/api/admin/finance/portal-grants/${users.a.grantId}/replace`).send({
        requestId: randomUUID(),
        hotelIds: [d.H1.id, d.H2.id],
        reason: 'Rozšíření (syntetické)',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      users.a.grantId = (res.body as FinancePortalGrantResult).grant.id;
      const a = users.a.browser;
      const list = await html(a, '/invoices');
      expect(list.text).toContain(d.A1.number);
      expect(list.text).toContain(d.A2.number);
      expect((await html(a, '/')).text).toContain(d.H2.name);
      expect((await a.get(`/invoices/${d.A2.id}/pdf`)).status).toBe(200);
      await shoot('a-invoices-after-replace', a.session, '/invoices');
    });

    it('5b. the ADMIN revokes A’s grant: A’s next request signs in again, the session is gone; signed in again A sees nothing', async () => {
      const a = users.a.browser;
      const session = a.session!;
      const res = await coreAdmin()
        .post(`/api/admin/identity/portal-grants/${users.a.grantId}/revoke`)
        .set('Cookie', TEST_SESSION_COOKIE)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ reason: 'Odebrání přístupu (syntetické)' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const home = await html(a, '/');
      expect([home.status, home.location]).toEqual([307, '/login']);
      expect((await a.get(`/invoices/${d.A1.id}/pdf`)).status).toBe(401);
      // The session is gone at the core, not just refused.
      const stored = await f.core.prisma.userSession.findFirstOrThrow({
        where: { tokenSha256: sha(session) },
      });
      expect(stored.revokedAt).not.toBeNull();
      const again = await signIn('a', 'recovery');
      const empty = await html(again, '/');
      expect(empty.status).toBe(200);
      expect(empty.text).toContain('Zatím nemáte přístup k žádnému hotelu.');
      const none = await html(again, '/invoices');
      expect(none.text).not.toContain(d.A1.number);
      expect((await again.get(`/invoices/${d.A1.id}/pdf`)).status).toBe(404);
      await shoot('a-after-revoke', again.session, '/');
    });

    it('sign-out: 204, the core ends the session, the next page is the sign-in', async () => {
      const b = await signIn('b', 'totp');
      const session = b.session!;
      expect((await b.post('/auth/logout')).status).toBe(204);
      expect(b.session).toBeNull();
      const stored = await f.core.prisma.userSession.findFirstOrThrow({
        where: { tokenSha256: sha(session) },
      });
      expect(stored.revokedAt).not.toBeNull();
      const reuse = new Browser();
      reuse.jar.set('__Host-ayvo_portal', session);
      expect((await html(reuse, '/')).location).toBe('/login');
      await shoot('login', null, '/login');
    });

    it('6. Finance down: "Faktury nejsou dostupné", while "Moje hotely" keeps working', async () => {
      const b = await signIn('b', 'recovery');
      await f.app.close();
      financeClosed = true;
      const list = await html(b, '/invoices');
      expect(list.text).toContain('Faktury nejsou dostupné');
      expect((await b.get(`/invoices/${d.B1.id}/pdf`)).status).toBe(503);
      const home = await html(b, '/');
      expect(home.status).toBe(200);
      expect(home.text).toContain(d.H3.name);
      await shoot('b-finance-down', b.session, '/invoices');
    });

    it('the screenshots taken (390 / 1440 px)', () => {
      if (process.env.PORTAL_WEB_WALK_SHOTS) console.log(shotLog.join(''));
    });
  },
);
