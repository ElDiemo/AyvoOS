import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PortalInvoicePage } from '@ayvo/types';
import { FINANCE_PORTAL_APPLICATION } from '../src/finance/finance-portal-prisma.service.js';
import { FinancePortalRequestLimit } from '../src/finance/portal-invoices.controller.js';
import { portalInvoiceKinds } from '../src/finance/portal-invoices.service.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, newTerms, payer } from './support/finance-portal.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';
import { invoicesCheck } from './support/portal-check.js';

const portalToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const P = '/api/internal/v1/portal/invoices';

/**
 * "Faktury" of the hotel portal (ADR 0045 §5, §6, §8 on `0d500f6`, PR 4b): portal-web's token,
 * the forwarded portal session introspected at the core on every request, ONE visibility predicate
 * for the list, the detail and the PDF, the PDF checked against its recorded hash and sent private,
 * a reserved pool and a request limit in Finance. Synthetic payers, hotels and TEST invoices only.
 */
describe.skipIf(!hasDatabase)('hotel portal invoices in Finance', () => {
  let f: FinanceTestApp;
  let actorId: string;
  let ids: Record<'A1' | 'A2' | 'B1' | 'B2', string>;
  let h: Record<'H1' | 'H2' | 'H3', string>;
  let payers: Record<'A' | 'B', string>;

  const http = () => request(f.app.getHttpServer());
  const portal = (path: string, session?: string, token = portalToken) => {
    const r = http().get(`${P}${path}`).set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const numbersOf = (page: PortalInvoicePage) => page.items.map((i) => i.id);

  /** A PORTAL account with these grants (payer → hotels) and a portal session of it. */
  async function account(grants: { payer: string; hotels: string[] }[]) {
    const user = await f.core.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal', audience: 'PORTAL' },
    });
    const made = [];
    for (const g of grants)
      made.push(
        await f.core.app.get(PortalGrantsService).issue(actorId, {
          requestId: randomUUID(),
          userId: user.id,
          payerCustomerId: g.payer,
          hotelIds: g.hotels,
          reason: 'synthetic portal grant',
          // Invoices are this file's subject: every hotel of a grant counts for them (v6).
          financeCheck: invoicesCheck(g.hotels),
        }),
      );
    const identity = await f.core.prisma.userIdentity.create({
      data: { userId: user.id, provider: 'LOCAL', subject: user.id, emailAtLink: user.email },
    });
    const s = await f.core.prisma.$transaction((tx) =>
      f.core.app.get(SessionsService).create(tx, {
        userId: user.id,
        identityId: identity.id,
        providerSessionId: null,
        audience: 'PORTAL',
      }),
    );
    return { user, session: s.token, grants: made };
  }

  beforeAll(async () => {
    f = await createFinanceTestApp({
      finance: {
        PORTAL_FINANCE_TOKEN_SHA256: sha(portalToken),
        FINANCE_PORTAL_DB_ACQUIRE_TIMEOUT_MS: '500',
        FINANCE_PORTAL_DB_STATEMENT_TIMEOUT_MS: '1500',
        FINANCE_PORTAL_PDF_TIMEOUT_MS: '1000',
        FINANCE_PORTAL_PDF_MAX_BYTES: String(32 * 1024 * 1024),
      },
    });
    actorId = (
      await f.core.prisma.user.create({ data: { email: unique('admin'), displayName: 'Admin' } })
    ).id;
    const A = await payer(f, 'Plátce A');
    const B = await payer(f, 'Plátce B');
    payers = { A: A.id, B: B.id };
    const [h1, h2, h3] = [await hotel(f), await hotel(f), await hotel(f)];
    h = { H1: h1.id, H2: h2.id, H3: h3.id };
    const a1 = await agreement(f, A.id, h1.id);
    const a2 = await agreement(f, A.id, h2.id);
    const b3 = await agreement(f, B.id, h3.id);
    const A1 = await invoice(f, [a1.code], '2026-08');
    const A2 = await invoice(f, [a1.code, a2.code], '2026-09'); // a summary over H1 and H2
    const B1 = await invoice(f, [b3.code], '2026-09');
    // H1 moves from A to B; B is billed for it later.
    await newTerms(f, a1.code, { customerId: B.id, reason: 'Hotel přešel k plátci B' });
    const B2 = await invoice(f, [a1.code], '2026-10');
    ids = { A1: A1.id, A2: A2.id, B1: B1.id, B2: B2.id };
  });
  afterAll(() => f?.close());

  describe('access', () => {
    it('only portal-web’s token, only a portal session', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      expect((await http().get(P).set('x-ayvo-portal-session', session)).status).toBe(401);
      const wrong = await portal('', session, randomBytes(32).toString('base64url'));
      expect([wrong.status, wrong.body.code]).toEqual([401, 'SERVICE_UNAUTHENTICATED']);
      expect((await portal('')).status).toBe(401);
      expect((await portal('', 'not-a-session')).status).toBe(401);
      // The core's introspection: Finance's token only; a staff session is no portal session.
      const core = () =>
        request(f.core.app.getHttpServer()).post('/api/internal/v1/finance/introspect-portal');
      expect((await core().set('x-ayvo-portal-session', session)).status).toBe(401);
      expect(
        (
          await core()
            .set('Authorization', `Bearer ${portalToken}`)
            .set('x-ayvo-portal-session', session)
        ).status,
      ).toBe(401);
      const staffSession = await f.core.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { email: unique('staff'), displayName: 'S' } });
        const i = await tx.userIdentity.create({
          data: { userId: u.id, provider: 'LOCAL', subject: u.id, emailAtLink: u.email },
        });
        return f.core.app.get(SessionsService).create(tx, {
          userId: u.id,
          identityId: i.id,
          providerSessionId: null,
          audience: 'STAFF',
        });
      });
      expect((await portal('', staffSession.token)).status).toBe(401);
      const own = await core()
        .set('Authorization', `Bearer ${f.env.FINANCE_SERVICE_TOKEN}`)
        .set('x-ayvo-portal-session', session);
      expect(own.status).toBe(200);
      expect(own.body.grants).toHaveLength(1);
    });
  });

  describe('one predicate for the list, the detail and the PDF', () => {
    it('a grant on H1 sees none of the summary invoice over H1 + H2; foreign ids are 404 everywhere', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const page = (await portal('', session).expect(200)).body as PortalInvoicePage;
      expect([numbersOf(page), page.total]).toEqual([[ids.A1], 1]);
      expect(page.items[0]).toMatchObject({
        kind: 'TEST',
        periodMonth: '2026-08',
        currency: 'CZK',
        hotels: [{ id: h.H1 }],
        paymentState: 'UNPAID',
        cancelled: false,
      });
      for (const id of [ids.A2, ids.B1, ids.B2, randomUUID()]) {
        for (const path of [`/${id}`, `/${id}/pdf`]) {
          const res = await portal(path, session);
          expect([res.status, res.body.code], path).toEqual([404, 'INVOICE_NOT_FOUND']);
        }
      }
      expect((await portal(`/${ids.A1}`, session)).status).toBe(200);
    });

    it('the PDF: the stored bytes, private, a download, nosniff', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const res = await portal(`/${ids.A1}/pdf`, session)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      const stored = await f.prisma.invoice.findUniqueOrThrow({ where: { id: ids.A1 } });
      expect(
        createHash('sha256')
          .update(res.body as Buffer)
          .digest('hex'),
      ).toBe(stored.pdfSha256);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.pdf"$/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('hotels of two grants are never combined; one grant covering both sees the summary', async () => {
      const both = await account([{ payer: payers.A, hotels: [h.H1, h.H2] }]);
      expect(numbersOf((await portal('', both.session).expect(200)).body).sort()).toEqual(
        [ids.A1, ids.A2].sort(),
      );
      // A on H1 plus B on H3 (and H1): A1, B1, B2 — never A2, which needs H1 and H2 in one grant.
      const two = await account([
        { payer: payers.A, hotels: [h.H1] },
        { payer: payers.B, hotels: [h.H3] },
      ]);
      const page = (await portal('', two.session).expect(200)).body as PortalInvoicePage;
      expect(numbersOf(page).sort()).toEqual([ids.A1, ids.B1].sort());
      // Pagination counts only what is visible.
      const p1 = (await portal('?pageSize=1', two.session).expect(200)).body as PortalInvoicePage;
      const p2 = (await portal('?pageSize=1&page=2', two.session).expect(200))
        .body as PortalInvoicePage;
      const p3 = (await portal('?pageSize=1&page=3', two.session).expect(200))
        .body as PortalInvoicePage;
      expect([p1.total, p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 1, 1, 0]);
      expect(new Set([...numbersOf(p1), ...numbersOf(p2)])).toEqual(new Set([ids.A1, ids.B1]));
    });

    it('a hotel that moved: its old invoices stay with the old payer’s grant, the new ones with the new payer’s', async () => {
      const old = await account([{ payer: payers.A, hotels: [h.H1] }]);
      expect(numbersOf((await portal('', old.session).expect(200)).body)).toEqual([ids.A1]);
      const now = await account([{ payer: payers.B, hotels: [h.H1] }]);
      expect(numbersOf((await portal('', now.session).expect(200)).body)).toEqual([ids.B2]);
      expect((await portal(`/${ids.A1}`, now.session)).status).toBe(404);
    });

    it('an invoice with no lines (forced by SQL) is visible to nobody', async () => {
      const lineless = randomUUID();
      const digits = (n: number) =>
        Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
      const number = `T9999-${digits(5)}`;
      const vs = `9${digits(9)}`;
      await withPrivileged(async (db) => {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
          await tx.$executeRawUnsafe(`
            INSERT INTO "finance"."invoices" ("id", "serial", "kind", "number", "variable_symbol",
              "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
              "total", "snapshot", "pdf_storage_key", "pdf_sha256", "issued_by", "issued_by_name",
              "request_id")
            SELECT '${lineless}', "serial" + 100000, "kind", '${number}', '${vs}',
              "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
              "total", "snapshot", "pdf_storage_key" || '-x', "pdf_sha256", "issued_by",
              "issued_by_name", '${randomUUID()}'
            FROM "finance"."invoices" WHERE "id" = '${ids.A1}'`);
        });
      });
      const all = await account([{ payer: payers.A, hotels: [h.H1, h.H2] }]);
      const page = (await portal('', all.session).expect(200)).body as PortalInvoicePage;
      expect(numbersOf(page)).not.toContain(lineless);
      expect(page.total).toBe(2);
      expect((await portal(`/${lineless}`, all.session)).status).toBe(404);
    });

    it('TEST invoices are never shown in production', () => {
      expect(portalInvoiceKinds('production')).toEqual([]);
      expect(portalInvoiceKinds('development')).toEqual(['TEST']);
      expect(portalInvoiceKinds('test')).toEqual(['TEST']);
    });

    it('revoked mid-session: the next request has no session', async () => {
      const a = await account([{ payer: payers.A, hotels: [h.H1] }]);
      expect((await portal('', a.session)).status).toBe(200);
      await f.core.app.get(PortalGrantsService).revoke(actorId, a.grants[0]!.id, 'ended');
      expect((await portal('', a.session)).status).toBe(401);
      expect((await portal(`/${ids.A1}/pdf`, a.session)).status).toBe(401);
    });
  });

  describe('the PDF when storage misbehaves', () => {
    it('altered bytes or a slow bucket: 503 and nothing sent; the slot is free again', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const slots = f.app.get(FinancePortalRequestLimit);
      f.storage.tamperGets = true;
      try {
        const res = await portal(`/${ids.A1}/pdf`, session);
        expect([res.status, res.body.code]).toEqual([503, 'INVOICES_UNAVAILABLE']);
        expect(res.headers['content-type']).toMatch(/json/);
      } finally {
        f.storage.tamperGets = false;
      }
      f.storage.delayGetsMs = 3000;
      try {
        const started = Date.now();
        const res = await portal(`/${ids.A1}/pdf`, session);
        expect([res.status, res.body.code]).toEqual([503, 'INVOICES_UNAVAILABLE']);
        expect(Date.now() - started).toBeLessThan(2500);
      } finally {
        f.storage.delayGetsMs = 0;
      }
      expect(slots.inFlight).toBe(0);
      expect((await portal(`/${ids.A1}/pdf`, session)).status).toBe(200);
    });
  });

  describe('reserved pool and request limit (ADR §8)', () => {
    /** Holds a lock in its own privileged transaction until released. */
    async function holding(sql: string) {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = withPrivileged((db) =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(sql);
            locked();
            await held;
          },
          { timeout: 30_000 },
        ),
      );
      await isLocked;
      return async () => {
        release();
        await holder;
      };
    }
    const portalBackends = async () =>
      (
        await f.prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${FINANCE_PORTAL_APPLICATION}`
      )[0]!.n;

    it('a stuck introspection holds at most 2 requests; the rest 503 at once; Finance staff work goes on', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const slots = f.app.get(FinancePortalRequestLimit);
      // The core's portal reads of grants wait: introspection cannot answer within its 2 s.
      const release = await holding(`LOCK TABLE "portal_grants" IN ACCESS EXCLUSIVE MODE`);
      try {
        const held = [Promise.resolve(portal('', session)), Promise.resolve(portal('', session))];
        for (let i = 0; i < 40 && slots.inFlight < 2; i++)
          await new Promise((r) => setTimeout(r, 25));
        expect(slots.inFlight).toBe(2);
        const busy = await portal('', session);
        expect([busy.status, busy.body.code]).toEqual([503, 'PORTAL_BUSY']);
        const started = Date.now();
        const staff = await f.get('/api/admin/finance/invoices');
        expect(staff.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(1500);
        const answers = await Promise.all(held);
        for (const a of answers) {
          expect(a.status).toBe(503);
          expect(Object.keys(a.body).sort()).toEqual(['code', 'message', 'statusCode']);
        }
        expect(slots.inFlight).toBe(0);
      } finally {
        await release();
      }
    });

    it('a stuck Finance read: one portal connection at most, 503 without data in time, slots free while the lock stays', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const slots = f.app.get(FinancePortalRequestLimit);
      const release = await holding(`LOCK TABLE "finance"."invoices" IN ACCESS EXCLUSIVE MODE`);
      try {
        const started = Date.now();
        const held = [Promise.resolve(portal('', session)), Promise.resolve(portal('', session))];
        await new Promise((r) => setTimeout(r, 300));
        expect(await portalBackends()).toBeLessThanOrEqual(1);
        const answers = await Promise.all(held);
        expect(answers.map((a) => [a.status, a.body.code])).toEqual([
          [503, 'INVOICES_UNAVAILABLE'],
          [503, 'INVOICES_UNAVAILABLE'],
        ]);
        expect(Date.now() - started).toBeLessThan(1500 + 500 + 1500);
        expect(slots.inFlight).toBe(0);
        // Clients that give up early leak no slot either.
        const aborted = await Promise.all(
          [1, 2].map(() =>
            Promise.resolve(portal('', session).timeout(100)).catch(() => 'aborted'),
          ),
        );
        expect(aborted).toEqual(['aborted', 'aborted']);
        for (let i = 0; i < 160 && slots.inFlight > 0; i++)
          await new Promise((r) => setTimeout(r, 25));
        expect(slots.inFlight).toBe(0);
      } finally {
        await release();
      }
      expect((await portal('', session)).status).toBe(200);
    });
  });

  describe('the PDF is bounded work: reading and sending', () => {
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('a slow bucket: every 503 is a stopped read — no read keeps running and no bytes arrive after it', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const slots = f.app.get(FinancePortalRequestLimit);
      f.storage.virtualSizeBytes = 4 * 1024 * 1024; // 64 chunks…
      f.storage.delayGetsMs = 200; // …far beyond the 1 s deadline
      try {
        for (let series = 0; series < 3; series++) {
          const started = Date.now();
          const answers = await Promise.all([
            portal(`/${ids.A1}/pdf`, session),
            portal(`/${ids.A1}/pdf`, session),
          ]);
          expect(answers.map((a) => [a.status, a.body.code])).toEqual([
            [503, 'INVOICES_UNAVAILABLE'],
            [503, 'INVOICES_UNAVAILABLE'],
          ]);
          expect(Date.now() - started).toBeLessThan(2000);
          // The slots were released only after the reads had really stopped.
          expect([slots.inFlight, f.storage.activeReads]).toEqual([0, 0]);
          const read = f.storage.bytesRead;
          await settle(500);
          expect(f.storage.bytesRead).toBe(read);
        }
      } finally {
        f.storage.virtualSizeBytes = 0;
        f.storage.delayGetsMs = 0;
      }
    });

    it('a huge object: the read stops at the size limit, never the whole object', async () => {
      const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
      const before = f.storage.bytesRead;
      f.storage.virtualSizeBytes = 200 * 1024 * 1024;
      try {
        const res = await portal(`/${ids.A1}/pdf`, session);
        expect([res.status, res.body.code]).toEqual([503, 'INVOICES_UNAVAILABLE']);
      } finally {
        f.storage.virtualSizeBytes = 0;
      }
      const read = f.storage.bytesRead - before;
      expect(read).toBeGreaterThan(32 * 1024 * 1024);
      expect(read).toBeLessThanOrEqual(32 * 1024 * 1024 + 64 * 1024);
      expect(f.storage.activeReads).toBe(0);
    });

    describe('a slow receiver', () => {
      let big: string;
      let url: (path: string) => URL;

      beforeAll(async () => {
        // A visible invoice whose stored PDF is large enough to fill the socket buffers.
        const bytes = randomBytes(24 * 1024 * 1024);
        const key = `finance-invoices/2026/11/${randomUUID()}.pdf`;
        await f.storage.put(key, bytes);
        big = randomUUID();
        const digits = (n: number) =>
          Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
        await withPrivileged((db) =>
          db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
            await tx.$executeRawUnsafe(`
              INSERT INTO "finance"."invoices" ("id", "serial", "kind", "number", "variable_symbol",
                "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
                "total", "snapshot", "pdf_storage_key", "pdf_sha256", "issued_by", "issued_by_name",
                "request_id")
              SELECT '${big}', "serial" + 200000, "kind", 'T9998-${digits(5)}', '8${digits(9)}',
                "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
                "total", "snapshot", '${key}', '${createHash('sha256').update(bytes).digest('hex')}',
                "issued_by", "issued_by_name", '${randomUUID()}'
              FROM "finance"."invoices" WHERE "id" = '${ids.A1}'`);
            await tx.$executeRawUnsafe(`
              INSERT INTO "finance"."invoice_lines"
              SELECT '${big}', "line_no", "agreement_id", "agreement_revision", "period_month",
                "hotel_id", "hotel_code", "hotel_name", "billed_rooms", "unit_price", "amount"
              FROM "finance"."invoice_lines" WHERE "invoice_id" = '${ids.A1}'`);
          }),
        );
        const server = f.app.getHttpServer();
        if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as AddressInfo).port;
        url = (path: string) => new URL(`http://127.0.0.1:${port}${P}${path}`);
      });

      /** A GET whose body is never read: the server cannot finish sending. */
      const stalled = (session: string) =>
        new Promise<{ res: IncomingMessage; destroy: () => void }>((resolve, reject) => {
          const req = httpGet(
            url(`/${big}/pdf`),
            {
              headers: {
                authorization: `Bearer ${portalToken}`,
                'x-ayvo-portal-session': session,
              },
            },
            (res) => {
              res.pause();
              resolve({ res, destroy: () => req.destroy() });
            },
          );
          req.on('error', () => undefined);
          req.once('error', reject);
        });
      const waitFor = async (cond: () => boolean, ms: number) => {
        const until = Date.now() + ms;
        while (!cond() && Date.now() < until) await settle(20);
        return cond();
      };

      it('its slot is held while the bytes wait, and freed when the client goes', async () => {
        const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
        const slots = f.app.get(FinancePortalRequestLimit);
        const a = await stalled(session);
        expect(a.res.statusCode).toBe(200);
        await settle(300);
        expect(slots.inFlight).toBe(1);
        a.destroy();
        expect(await waitFor(() => slots.inFlight === 0, 500)).toBe(true);
      });

      it('two stalled receivers take both slots; a third PDF is refused at once; the deadline cuts them off', async () => {
        const { session } = await account([{ payer: payers.A, hotels: [h.H1] }]);
        const slots = f.app.get(FinancePortalRequestLimit);
        const started = Date.now();
        const [a, b] = await Promise.all([stalled(session), stalled(session)]);
        expect(slots.inFlight).toBe(2);
        const third = await portal(`/${ids.A1}/pdf`, session);
        expect([third.status, third.body.code]).toEqual([503, 'PORTAL_BUSY']);
        // The 1 s deadline covers the sending too: the server cuts both connections and frees
        // the slots while the receivers still have not read a byte.
        expect(await waitFor(() => slots.inFlight === 0, 2500)).toBe(true);
        expect(Date.now() - started).toBeLessThan(2500);
        a.destroy();
        b.destroy();
        expect((await portal(`/${ids.A1}/pdf`, session)).status).toBe(200);
      });
    });
  });
});
