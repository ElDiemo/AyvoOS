import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  commissionMineSchema,
  commissionPreviewSchema,
  commissionStatementSchema,
  type CommissionPreview,
  type CommissionStatementPreview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';

/**
 * Sales commissions PR 2c — approving one salesperson's statement (doc 069 §5d) and the
 * salesperson's own view; owner OK GO 2026-11-18 for DEV with synthetic TEST data. Finance as it
 * runs (own app and DB role, the core over real HTTP through a proxy that counts and can fail the
 * contract's batches). `f`: the test superuser as the admin; `real`: real sign-in (a second
 * ADMIN, salespeople). Every scenario uses its own salespeople and hotels (shared database).
 */
const OCT = '2026-10';
const SEP = '2026-09';

describe.skipIf(!hasDatabase)('Finance: approving a commission statement (doc 069 §5d)', () => {
  let f: FinanceTestApp;
  let real: FinanceTestApp;
  let proxy: Server;
  const calls: number[] = [];
  let failFrom: number | null = null;
  const tag = randomUUID().slice(0, 6);
  const SU = 'ayvo_session=finance-test-session';
  let payerId = '';
  let adminId = '';
  let admin2 = '';

  const core = () => request(f.core.app.getHttpServer());
  const preview = async (month: string) => {
    const res = await f.get(`/api/admin/finance/commissions/preview?month=${month}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return commissionPreviewSchema.parse(res.body) as CommissionPreview;
  };
  const of = (p: CommissionPreview, sp: { id: string }) =>
    p.statements.find((s) => s.salesperson.id === sp.id);
  const approve = (body: Record<string, unknown>, cookie?: string) =>
    (cookie
      ? real.post('/api/admin/finance/commissions/statements', cookie)
      : f.post('/api/admin/finance/commissions/statements')
    ).send(body);
  const bodyOf = (s: CommissionStatementPreview, month: string, requestId = randomUUID()) => ({
    requestId,
    month,
    salespersonId: s.salesperson.id,
    currency: 'CZK',
    mode: 'TEST',
    fingerprint: s.fingerprint,
  });
  const counts = (salespersonId: string) =>
    withPrivileged(async (db) => {
      const [r] = await db.$queryRaw<{ s: number; i: number; e: number }[]>`
        SELECT (SELECT count(*)::int FROM "finance"."commission_statements" WHERE "salesperson_id" = ${salespersonId}::uuid) AS s,
               (SELECT count(*)::int FROM "finance"."commission_statement_items" WHERE "salesperson_id" = ${salespersonId}::uuid) AS i,
               (SELECT count(*)::int FROM "finance"."commission_statement_events" e
                  JOIN "finance"."commission_statements" s ON s."id" = e."statement_id"
                 WHERE s."salesperson_id" = ${salespersonId}::uuid) AS e`;
      return r!;
    });
  const opRow = (requestId: string) =>
    withPrivileged((db) =>
      db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "finance"."operation_requests"
        WHERE "request_id" = ${requestId}::uuid`.then((r) => r[0]!.n),
    );

  /** A salesperson who can sign in (real), with terms 20 % / 24 months / 5 %. */
  async function salesperson(name: string, withTerms = true) {
    const user = await prepareInvitedUser(real.core, {
      email: `fca-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `${name} ${tag}`,
    });
    await real.core.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'SALES', grantReason: 'test: salesperson' },
    });
    if (withTerms) {
      const res = await core().post('/api/admin/sales/commission-terms').set('Cookie', SU).send({
        requestId: randomUUID(),
        salespersonId: user.id,
        expectedVersion: 0,
        reason: 'smlouva',
        confirm: true,
        initialRate: '20',
        initialMonths: 24,
        maintenanceRate: '5',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    return { id: user.id, email: user.email, name: `${name} ${tag}` };
  }
  /** A hotel attributed to the salesperson from 2026-08, with its billing agreement. */
  async function hotelOf(sp: { id: string }, name: string) {
    const x = await hotel(f, `Hotel ${name} ${tag}`);
    const ag = await agreement(f, payerId, x.id);
    const res = await core()
      .post(`/api/admin/hotels/${x.code}/sales-attribution`)
      .set('Cookie', SU)
      .send({
        requestId: randomUUID(),
        expectedRevision: 0,
        source: 'MANUAL',
        reason: 'stávající hotel',
        confirm: true,
        salespersonId: sp.id,
        commissionStart: '2026-08',
        confirmCommissionStart: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: x.id, code: x.code, agreement: ag.code };
  }
  const cancelSql = (invoiceId: string) => `INSERT INTO "finance"."invoice_cancellations"
    ("invoice_id", "reason", "cancelled_by", "cancelled_by_name", "request_id")
    VALUES ('${invoiceId}', 'syntetické storno', '${randomUUID()}', 'Test', '${randomUUID()}')`;
  const cancel = (invoiceId: string) =>
    withPrivileged((db) => db.$executeRawUnsafe(cancelSql(invoiceId)));

  beforeAll(async () => {
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url?.endsWith('/commissions/attributions')) {
          calls.push((JSON.parse(body.toString()) as { hotelIds: string[] }).hotelIds.length);
          if (failFrom !== null && calls.length >= failFrom) {
            res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
            return;
          }
        }
        const port = (f.core.app.getHttpServer().address() as AddressInfo).port;
        const up = httpRequest(
          { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          },
        );
        up.end(body);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    f = await createFinanceTestApp({
      coreUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    });
    real = await createFinanceTestApp({ core: { auth: 'real' } });
    const second = await prepareInvitedUser(real.core, {
      email: `fca-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Druhý admin',
    });
    adminId = second.id;
    await real.core.prisma.userRole.create({
      data: { userId: second.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin2 = await sessionCookie(real.core, second.email);
    payerId = (await payer(f, `Plátce schvalování ${tag}`)).id;
  }, 120_000);
  afterAll(async () => {
    // Test files share one database: the identity tests bootstrap the first ADMIN themselves.
    await real?.core.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await real?.close();
    await f?.close();
    await new Promise((resolve) => proxy?.close(resolve));
  });

  it('approves as previewed, once; a replay needs no core; another actor conflicts; the salesperson sees one amount', async () => {
    const a = await salesperson('Alena Schvalovaná');
    const b = await salesperson('Bohdan Souhrnný');
    const a1 = await hotelOf(a, 'A1');
    const a2 = await hotelOf(a, 'A2');
    const b1 = await hotelOf(b, 'B1');
    await invoice(f, [a1.agreement], OCT);
    // A summary invoice: one line Alena, one line Bohdan.
    await invoice(f, [a2.agreement, b1.agreement], OCT);

    const sales = {
      a: await sessionCookie(real.core, a.email),
      b: await sessionCookie(real.core, b.email),
    };
    const mine = async (cookie: string) => {
      const res = await real.get(`/api/admin/finance/commissions/mine?month=${OCT}`, cookie);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return commissionMineSchema.parse(res.body);
    };
    expect(await mine(sales.a)).toMatchObject({ state: 'PROCESSING', amountToInvoice: null });

    const before = await preview(OCT);
    const sa = of(before, a)!;
    const sb = of(before, b)!;
    expect(sa.items.map((i) => [i.hotelCode, i.amount])).toEqual(
      expect.arrayContaining([
        [a1.code, '200.00'],
        [a2.code, '200.00'],
      ]),
    );
    // Only an admin approves: the salesperson is refused (403) — also the list.
    expect((await approve(bodyOf(sa, OCT), sales.a)).status).toBe(403);
    expect(
      (await real.get(`/api/admin/finance/commissions/statements?month=${OCT}`, sales.a)).status,
    ).toBe(403);

    const r1 = randomUUID();
    const res = await approve(bodyOf(sa, OCT, r1));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const st = commissionStatementSchema.parse(res.body);
    expect(st).toMatchObject({
      month: OCT,
      mode: 'TEST',
      salesperson: { id: a.id },
      previousPeriod: null,
      openingBalance: '0.00',
      total: '400.00',
      amountToInvoice: '400.00',
      carriedForward: '0.00',
      fingerprint: sa.fingerprint,
    });
    expect(st.items).toHaveLength(2);
    expect(await counts(a.id)).toEqual({ s: 1, i: 2, e: 1 });

    // Approving Alena never makes Bohdan stale (own sources only), and Alena is no longer due.
    const after = await preview(OCT);
    expect(of(after, b)!.fingerprint).toBe(sb.fingerprint);
    expect(of(after, a)).toBeUndefined();

    // A lost answer: the same request again, with the core down — the stored result, no call.
    const seen = calls.length;
    failFrom = seen + 1;
    try {
      const again = await approve(bodyOf(sa, OCT, r1));
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toEqual(res.body);
      expect(calls.length).toBe(seen);
    } finally {
      failFrom = null;
    }
    // Another request for the same month; the same request id by another admin.
    expect((await approve(bodyOf(sa, OCT))).body).toMatchObject({ code: 'ALREADY_APPROVED' });
    const other = await approve(bodyOf(sa, OCT, r1), admin2);
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await counts(a.id)).toEqual({ s: 1, i: 2, e: 1 });

    // The salesperson's own view: the state and one amount — nothing about hotels or invoices.
    const own = await mine(sales.a);
    expect(own).toEqual({
      month: OCT,
      mode: 'TEST',
      state: 'TO_INVOICE',
      currency: 'CZK',
      amountToInvoice: '400.00',
      balanceCarriedForward: null,
      approvedAt: st.approvedAt,
    });
    expect(JSON.stringify(own)).not.toMatch(/T\d{4}-\d{5}|HOT|hotel/i);
    // Bohdan sees only his own (not approved yet).
    expect(await mine(sales.b)).toMatchObject({ state: 'PROCESSING', amountToInvoice: null });

    const list = await f.get(`/api/admin/finance/commissions/statements?month=${OCT}`);
    expect(list.status).toBe(200);
    expect((list.body as { statements: { id: string }[] }).statements.map((s) => s.id)).toContain(
      st.id,
    );
  });

  it('refuses a stale fingerprint, a flagged statement, an open month, nothing to approve and a malformed body', async () => {
    const c = await salesperson('Cyril Bezpodmínek', false);
    const d = await salesperson('Dana Zastaralá');
    await invoice(f, [(await hotelOf(c, 'C1')).agreement], OCT);
    await invoice(f, [(await hotelOf(d, 'D1')).agreement], OCT);
    const p = await preview(OCT);
    const sc = of(p, c)!;
    const sd = of(p, d)!;
    expect(sc.flags.map((x) => x.code)).toEqual(['TERMS_MISSING']);

    const flagged = await approve(bodyOf(sc, OCT));
    expect([flagged.status, flagged.body.code]).toEqual([422, 'STATEMENT_FLAGGED']);
    const wrong = await approve({ ...bodyOf(sd, OCT), fingerprint: 'f'.repeat(64) });
    expect([wrong.status, wrong.body.code]).toEqual([409, 'STATEMENT_STALE']);
    const open = await approve({ ...bodyOf(sd, OCT), month: '2026-11' });
    expect([open.status, open.body.code]).toEqual([422, 'MONTH_NOT_CLOSED']);
    const none = await approve({ ...bodyOf(sd, OCT), salespersonId: randomUUID() });
    expect([none.status, none.body.code]).toEqual([422, 'NOTHING_TO_APPROVE']);
    expect((await approve({ ...bodyOf(sd, OCT), currency: 'EUR' })).status).toBe(400);
    expect((await approve({ ...bodyOf(sd, OCT), extra: 1 })).status).toBe(400);
    expect(await counts(c.id)).toEqual({ s: 0, i: 0, e: 0 });
    expect(await counts(d.id)).toEqual({ s: 0, i: 0, e: 0 });
  });

  it('concurrent approvals: two request ids → one statement; the same request id twice → the same result', async () => {
    const e = await salesperson('Emil Souběžný');
    const g = await salesperson('Gita Opakovaná');
    await invoice(f, [(await hotelOf(e, 'E1')).agreement], OCT);
    await invoice(f, [(await hotelOf(g, 'G1')).agreement], OCT);
    const p = await preview(OCT);

    const two = await Promise.all([
      approve(bodyOf(of(p, e)!, OCT)),
      approve(bodyOf(of(p, e)!, OCT)),
    ]);
    expect(two.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(two.find((r) => r.status === 409)!.body.code).toBe('ALREADY_APPROVED');
    expect(await counts(e.id)).toEqual({ s: 1, i: 1, e: 1 });

    const id = randomUUID();
    const same = await Promise.all([
      approve(bodyOf(of(p, g)!, OCT, id)),
      approve(bodyOf(of(p, g)!, OCT, id)),
    ]);
    expect(same.map((r) => r.status)).toEqual([200, 200]);
    expect(same[0]!.body.id).toBe(same[1]!.body.id);
    expect(await counts(g.id)).toEqual({ s: 1, i: 1, e: 1 });
  });

  it('a cancellation committed during the approval → STATEMENT_STALE; a failed hotel batch → 503; nothing written, the same request id then succeeds', async () => {
    const hh = await salesperson('Hana Stornovaná');
    const i = await salesperson('Ivo Výpadek');
    const vh = await invoice(f, [(await hotelOf(hh, 'H1')).agreement], OCT);
    await invoice(f, [(await hotelOf(i, 'I1')).agreement], OCT);
    const p = await preview(OCT);

    // The cancellation holds its lock (not committed) while the approval runs; then it commits.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inside!: () => void;
    const started = new Promise<void>((r) => (inside = r));
    const cancelling = withPrivileged((db) =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(cancelSql(vh.id));
          inside();
          await held;
        },
        { timeout: 30_000 },
      ),
    );
    await started;
    const rid = randomUUID();
    const approving = approve(bodyOf(of(p, hh)!, OCT, rid)).then((r) => r);
    for (let n = 0; ; n++) {
      const [w] = await withPrivileged(
        (db) =>
          db.$queryRaw<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      if (w!.n > 0) break;
      if (n > 200) throw new Error('the approval never waited for the cancellation');
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await cancelling;
    const stale = await approving;
    expect([stale.status, stale.body.code]).toEqual([409, 'STATEMENT_STALE']);
    expect(await counts(hh.id)).toEqual({ s: 0, i: 0, e: 0 });
    expect(await opRow(rid)).toBe(0);
    // The next preview no longer has the cancelled line for Hana.
    expect(of(await preview(OCT), hh)).toBeUndefined();

    // A hotel batch of the core fails: 503, nothing written; the same request id later succeeds.
    const si = of(p, i)!;
    const rid2 = randomUUID();
    failFrom = calls.length + 1;
    let down;
    try {
      down = await approve(bodyOf(si, OCT, rid2));
    } finally {
      failFrom = null;
    }
    expect([down.status, down.body.code]).toEqual([503, 'FINANCE_DEPENDENCY_UNAVAILABLE']);
    expect(await counts(i.id)).toEqual({ s: 0, i: 0, e: 0 });
    expect(await opRow(rid2)).toBe(0);
    const ok = await approve(bodyOf(si, OCT, rid2));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await counts(i.id)).toEqual({ s: 1, i: 1, e: 1 });
  });

  it('months in order; a storno after approval is a correction of the next month; a negative result is carried, nothing to invoice', async () => {
    const j = await salesperson('Jana Pořadí');
    const k = await salesperson('Karel Záporný');
    const jh = await hotelOf(j, 'J1');
    const jSep = await invoice(f, [jh.agreement], SEP);
    await invoice(f, [jh.agreement], OCT);
    const kSep = await invoice(f, [(await hotelOf(k, 'K1')).agreement], SEP);

    // October waits for September (EARLIER_PERIOD_OPEN).
    const oct0 = of(await preview(OCT), j)!;
    expect(oct0.flags.map((x) => [x.code, x.dueMonth])).toEqual([['EARLIER_PERIOD_OPEN', SEP]]);
    expect((await approve(bodyOf(oct0, OCT))).body.code).toBe('STATEMENT_FLAGGED');

    const sep = await preview(SEP);
    for (const sp of [j, k]) expect((await approve(bodyOf(of(sep, sp)!, SEP))).status).toBe(200);
    // September of Jana is cancelled after its approval: October gets the storno.
    await cancel(jSep.id);
    await cancel(kSep.id);
    const oct = await preview(OCT);
    const sj = of(oct, j)!;
    expect(sj.items.map((x) => [x.kind, x.cause, x.serviceMonth, x.amount])).toEqual(
      expect.arrayContaining([
        ['REGULAR', 'REGULAR', OCT, '200.00'],
        ['CORRECTION', 'CANCELLED', SEP, '-200.00'],
      ]),
    );
    expect(sj).toMatchObject({ previousPeriod: SEP, total: '0.00', amountToInvoice: '0.00' });
    const approvedJ = await approve(bodyOf(sj, OCT));
    expect(approvedJ.status, JSON.stringify(approvedJ.body)).toBe(200);
    // September again → ALREADY_APPROVED (that one exists); a later one exists → in order only.
    expect((await approve(bodyOf(of(sep, j)!, SEP))).body.code).toBe('ALREADY_APPROVED');

    // Karel: only the storno in October → a negative result, carried; nothing to invoice.
    const sk = of(oct, k)!;
    expect(sk).toMatchObject({
      total: '-200.00',
      closingBalance: '-200.00',
      amountToInvoice: '0.00',
      carriedForward: '-200.00',
    });
    expect((await approve(bodyOf(sk, OCT))).status).toBe(200);
    const kc = await sessionCookie(real.core, k.email);
    const kMine = await real.get(`/api/admin/finance/commissions/mine?month=${OCT}`, kc);
    expect(kMine.body).toMatchObject({
      state: 'NOTHING_TO_INVOICE',
      amountToInvoice: null,
      balanceCarriedForward: '-200.00',
    });
    // A later statement exists: an earlier month for which nothing was approved is PERIOD_ORDER.
    const late = await approve({ ...bodyOf(sk, '2026-08'), fingerprint: sk.fingerprint });
    expect([late.status, late.body.code]).toEqual([409, 'PERIOD_ORDER']);
  });
});
