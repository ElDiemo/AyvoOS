import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  commissionMineSchema,
  commissionPreviewSchema,
  commissionStatementSchema,
  type CommissionPreview,
  type CommissionStatement,
  type CommissionStatementPreview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';

/**
 * Sales commissions — ONE reproducible pass through the monthly closing with synthetic data
 * (doc 069 §5–§6; owner OK GO 2026-11-18 for DEV with synthetic TEST data; night brief
 * 2026-11-18/19). July–October 2026, every line 1 000.00 (fixture), terms 20 % / 24 months / 5 %
 * (Alena, Karel) and 10 % / 36 / 3 % (Bohdan), all hotels from 2026-07 (k = 1 in July):
 *
 *   July    Alena: two hotels (one invoice paid by the hotel, one unpaid — the same commission);
 *           a summary invoice A2 + B1 splits between Alena and Bohdan. Alena's invoice received
 *           7. 8. → payout 15. 8.; Bohdan's received 18. 11. (months late) → 15. 12.
 *   August  Alena A1, Karel K1. After the approval both invoices are cancelled (storno), and a late
 *           August invoice of A2 is issued.
 *   Sept.   storno −200 for Alena and Karel, the late August line for Alena (original month and
 *           rate), and the real correction of B1 (Bohdan → Alena, the same month): −100 Bohdan,
 *           +200 Alena — Bohdan's reversal is due in August (§5a), so his August is approved
 *           now. Karel and Bohdan end negative: carried, nothing to invoice. One hotel batch
 *           of the core fails during an approval: 503, nothing written, the same request repeats.
 *   October Karel's two lines net the −200 carried (amount to invoice 200); Alena's statement and
 *           her invoice received 18. 11. 2026 → payout 15. 12. 2026.
 *
 * Only an admin approves and records; each salesperson sees only their own statement and one
 * amount. Approved statements never change. Nothing is paid and nothing goes to accounting.
 */
describe.skipIf(!hasDatabase)('Finance: commission closing — the whole pass (doc 069)', () => {
  let f: FinanceTestApp;
  let real: FinanceTestApp;
  let proxy: Server;
  const calls: number[] = [];
  let failNext = false;
  const tag = randomUUID().slice(0, 6);
  const SU = 'ayvo_session=finance-test-session';
  const people: Record<'a' | 'b' | 'k', { id: string; email: string; cookie: string }> =
    {} as never;
  const h: Record<'a1' | 'a2' | 'b1' | 'k1', { id: string; code: string; agreement: string }> =
    {} as never;
  const approved: Record<string, CommissionStatement> = {};

  const core = () => request(f.core.app.getHttpServer());
  const preview = async (month: string) => {
    const res = await f.get(`/api/admin/finance/commissions/preview?month=${month}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return commissionPreviewSchema.parse(res.body) as CommissionPreview;
  };
  const of = (p: CommissionPreview, who: 'a' | 'b' | 'k') =>
    p.statements.find((s) => s.salesperson.id === people[who].id);
  const items = (s: CommissionStatementPreview | CommissionStatement | undefined) =>
    (s?.items ?? []).map((i) => `${i.cause} ${i.hotelCode} ${i.serviceMonth} ${i.amount}`).sort();
  const approve = async (s: CommissionStatementPreview, month: string, requestId = randomUUID()) =>
    f.post('/api/admin/finance/commissions/statements').send({
      requestId,
      month,
      salespersonId: s.salesperson.id,
      currency: 'CZK',
      mode: 'TEST',
      fingerprint: s.fingerprint,
    });
  const approveOk = async (month: string, who: 'a' | 'b' | 'k', p: CommissionPreview) => {
    const res = await approve(of(p, who)!, month);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (approved[`${who}${month}`] = commissionStatementSchema.parse(res.body));
  };
  const record = (statementId: string, body: Record<string, unknown>, cookie?: string) =>
    (cookie
      ? real.post(
          `/api/admin/finance/commissions/statements/${statementId}/salesperson-invoice`,
          cookie,
        )
      : f.post(`/api/admin/finance/commissions/statements/${statementId}/salesperson-invoice`)
    ).send({ requestId: randomUUID(), currency: 'CZK', ...body });
  const mine = async (who: 'a' | 'b' | 'k', month: string) => {
    const res = await real.get(
      `/api/admin/finance/commissions/mine?month=${month}`,
      people[who].cookie,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return commissionMineSchema.parse(res.body);
  };
  const cancel = (invoiceId: string) =>
    withPrivileged(
      (db) =>
        db.$executeRaw`INSERT INTO "finance"."invoice_cancellations"
        ("invoice_id", "reason", "cancelled_by", "cancelled_by_name", "request_id")
        VALUES (${invoiceId}::uuid, 'syntetické storno', ${randomUUID()}::uuid, 'Test', ${randomUUID()}::uuid)`,
    );
  const attribute = async (code: string, body: Record<string, unknown>) => {
    const res = await core()
      .post(`/api/admin/hotels/${code}/sales-attribution`)
      .set('Cookie', SU)
      .send({ requestId: randomUUID(), source: 'MANUAL', confirm: true, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };

  beforeAll(async () => {
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url?.endsWith('/commissions/attributions')) {
          calls.push((JSON.parse(body.toString()) as { hotelIds: string[] }).hotelIds.length);
          if (failNext) {
            failNext = false;
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

    const terms: Record<'a' | 'b' | 'k', object> = {
      a: { initialRate: '20', initialMonths: 24, maintenanceRate: '5' },
      b: { initialRate: '10', initialMonths: 36, maintenanceRate: '3' },
      k: { initialRate: '20', initialMonths: 24, maintenanceRate: '5' },
    };
    const names = { a: 'Alena Průchodová', b: 'Bohdan Průchodový', k: 'Karel Průchodový' };
    for (const who of ['a', 'b', 'k'] as const) {
      const user = await prepareInvitedUser(real.core, {
        email: `fcw-${who}-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: `${names[who]} ${tag}`,
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test: salesperson' },
      });
      const res = await core()
        .post('/api/admin/sales/commission-terms')
        .set('Cookie', SU)
        .send({
          requestId: randomUUID(),
          salespersonId: user.id,
          expectedVersion: 0,
          reason: 'smlouva',
          confirm: true,
          ...terms[who],
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      people[who] = {
        id: user.id,
        email: user.email,
        cookie: await sessionCookie(real.core, user.email),
      };
    }
    const p = await payer(f, `Plátce průchodu ${tag}`);
    const owner = { a1: 'a', a2: 'a', b1: 'b', k1: 'k' } as const;
    for (const key of ['a1', 'a2', 'b1', 'k1'] as const) {
      const x = await hotel(f, `Hotel ${key.toUpperCase()} průchod ${tag}`);
      const ag = await agreement(f, p.id, x.id);
      h[key] = { id: x.id, code: x.code, agreement: ag.code };
      await attribute(x.code, {
        expectedRevision: 0,
        reason: 'stávající hotel',
        salespersonId: people[owner[key]].id,
        commissionStart: '2026-07',
        confirmCommissionStart: true,
      });
    }
  }, 180_000);
  afterAll(async () => {
    await real?.close();
    await f?.close();
    await new Promise((resolve) => proxy?.close(resolve));
  });

  it('July: several hotels and a summary invoice; the hotel payment changes nothing; invoices received on time and months late', async () => {
    const paid = await invoice(f, [h.a1.agreement], '2026-07');
    await invoice(f, [h.a2.agreement, h.b1.agreement], '2026-07');
    const before = await preview('2026-07');

    // The hotel pays one invoice (simulated bank entry, paired by its variable symbol).
    const [vs] = await withPrivileged(
      (db) =>
        db.$queryRaw<{ variable_symbol: string; total: string }[]>`
        SELECT "variable_symbol", "total"::text FROM "finance"."invoices" WHERE "id" = ${paid.id}::uuid`,
    );
    const sim = await f.post('/api/admin/finance/payments/simulate').send({
      requestId: randomUUID(),
      entries: [
        {
          reference: `PRUCHOD-${tag.toUpperCase()}`,
          amount: vs!.total,
          currency: 'CZK',
          bookedOn: new Date().toISOString().slice(0, 10),
          variableSymbol: vs!.variable_symbol,
          counterpartyName: 'Hotel (syntetický)',
          message: null,
        },
      ],
    });
    expect(sim.status, JSON.stringify(sim.body)).toBeLessThan(300);
    const [alloc] = await withPrivileged(
      (db) =>
        db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "finance"."payment_allocations"
        WHERE "invoice_id" = ${paid.id}::uuid`,
    );
    expect(alloc!.n).toBe(1);

    const july = await preview('2026-07');
    // Paid or not, the same items and the same fingerprint: the payment is never an input.
    for (const who of ['a', 'b'] as const)
      expect(of(july, who)!.fingerprint).toBe(of(before, who)!.fingerprint);
    expect(items(of(july, 'a'))).toEqual(
      [`REGULAR ${h.a1.code} 2026-07 200.00`, `REGULAR ${h.a2.code} 2026-07 200.00`].sort(),
    );
    expect(items(of(july, 'b'))).toEqual([`REGULAR ${h.b1.code} 2026-07 100.00`]);

    // Only an admin approves (the salesperson: 403); then each salesperson sees only their own.
    const asSales = await real
      .post('/api/admin/finance/commissions/statements', people.a.cookie)
      .send({
        requestId: randomUUID(),
        month: '2026-07',
        salespersonId: people.a.id,
        currency: 'CZK',
        mode: 'TEST',
        fingerprint: of(july, 'a')!.fingerprint,
      });
    expect(asSales.status).toBe(403);
    const a7 = await approveOk('2026-07', 'a', july);
    const b7 = await approveOk('2026-07', 'b', july);
    expect([a7.amountToInvoice, b7.amountToInvoice]).toEqual(['400.00', '100.00']);
    expect(await mine('a', '2026-07')).toMatchObject({
      state: 'TO_INVOICE',
      amountToInvoice: '400.00',
    });
    expect(await mine('b', '2026-07')).toMatchObject({
      state: 'TO_INVOICE',
      amountToInvoice: '100.00',
    });
    expect(await mine('k', '2026-07')).toMatchObject({
      state: 'PROCESSING',
      amountToInvoice: null,
    });

    // The salesperson's invoices: only an admin records them; the payout from the actual receipt.
    expect(
      (
        await record(
          a7.id,
          {
            invoiceNumber: 'A-2026-07',
            issuedOn: '2026-08-05',
            receivedOn: '2026-08-07',
            base: '400.00',
          },
          people.a.cookie,
        )
      ).status,
    ).toBe(403);
    const ra = await record(a7.id, {
      invoiceNumber: 'A-2026-07',
      issuedOn: '2026-08-05',
      receivedOn: '2026-08-07',
      base: '400.00',
    });
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(ra.body.salespersonInvoice).toMatchObject({
      receivedOn: '2026-08-07',
      payoutOn: '2026-08-15',
    });
    // Bohdan's, received months late on 18. 11. → the run of 15. 12. (never before the receipt).
    const rid = randomUUID();
    const rb = await record(b7.id, {
      requestId: rid,
      invoiceNumber: 'B-7',
      issuedOn: '2026-11-17',
      receivedOn: '2026-11-18',
      base: '100.00',
    });
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.salespersonInvoice).toMatchObject({ payoutOn: '2026-12-15' });
    // A lost answer: the same request returns the same; another one is refused (one per statement).
    const again = await record(b7.id, {
      requestId: rid,
      invoiceNumber: 'B-7',
      issuedOn: '2026-11-17',
      receivedOn: '2026-11-18',
      base: '100.00',
    });
    expect([again.status, again.body]).toEqual([200, rb.body]);
    const second = await record(b7.id, {
      invoiceNumber: 'B-7b',
      issuedOn: '2026-11-17',
      receivedOn: '2026-11-18',
      base: '100.00',
    });
    expect([second.status, second.body.code]).toEqual([409, 'SALESPERSON_INVOICE_EXISTS']);
    expect(await mine('b', '2026-07')).toMatchObject({
      state: 'INVOICE_RECEIVED',
      amountToInvoice: '100.00',
      payoutPlannedOn: '2026-12-15',
    });
  });

  it('August: approved, then cancelled; a late August invoice issued after the approval', async () => {
    const aug = await preview('2026-08');
    expect(of(aug, 'b')).toBeUndefined();
    // August arrives only now for Alena's A1 and Karel's K1.
    const a1 = await invoice(f, [h.a1.agreement], '2026-08');
    const k1 = await invoice(f, [h.k1.agreement], '2026-08');
    const p = await preview('2026-08');
    expect(items(of(p, 'a'))).toEqual([`REGULAR ${h.a1.code} 2026-08 200.00`]);
    expect(of(p, 'a')!.previousPeriod).toBe('2026-07');
    const a8 = await approveOk('2026-08', 'a', p);
    await approveOk('2026-08', 'k', p);
    // Storno after the approval, and an August invoice issued late (after the approval).
    await cancel(a1.id);
    await cancel(k1.id);
    await invoice(f, [h.a2.agreement], '2026-08');
    // The approved August never changes.
    const list = await f.get('/api/admin/finance/commissions/statements?month=2026-08');
    const stored = (list.body as { statements: CommissionStatement[] }).statements.find(
      (s) => s.id === a8.id,
    )!;
    expect(stored).toEqual({ ...a8, salespersonInvoice: null });
    // August has nothing due any more (the corrections and the late line go to September).
    expect(of(await preview('2026-08'), 'a')).toBeUndefined();
  });

  it('September: storno, the late line, a real correction of the salesperson; negative results carried; a failed hotel batch', async () => {
    // The real correction of B1 for the same first month: Bohdan → Alena (revision 2).
    await attribute(h.b1.code, {
      expectedRevision: 1,
      reason: 'oprava: hotel získala Alena',
      salespersonId: people.a.id,
      effectiveFrom: '2026-07',
    });
    const sep = await preview('2026-09');
    expect(items(of(sep, 'a'))).toEqual(
      [
        `CANCELLED ${h.a1.code} 2026-08 -200.00`,
        `REGULAR ${h.a2.code} 2026-08 200.00`,
        `REATTRIBUTED:2 ${h.b1.code} 2026-07 200.00`,
      ].sort(),
    );
    // Bohdan's reversal is due in August (the month after his July item; he has no August yet,
    // §5a): his September waits for it.
    expect(of(sep, 'b')).toMatchObject({
      items: [],
      flags: [expect.objectContaining({ code: 'EARLIER_PERIOD_OPEN', dueMonth: '2026-08' })],
    });
    const aug = await preview('2026-08');
    expect(items(of(aug, 'b'))).toEqual([`REATTRIBUTED:2 ${h.b1.code} 2026-07 -100.00`]);
    const b8 = await approveOk('2026-08', 'b', aug);
    expect(b8).toMatchObject({
      previousPeriod: '2026-07',
      closingBalance: '-100.00',
      amountToInvoice: '0.00',
      carriedForward: '-100.00',
    });
    expect(await mine('b', '2026-08')).toMatchObject({
      state: 'NOTHING_TO_INVOICE',
      balanceCarriedForward: '-100.00',
    });
    expect(of(await preview('2026-09'), 'b')).toBeUndefined();
    expect(items(of(sep, 'k'))).toEqual([`CANCELLED ${h.k1.code} 2026-08 -200.00`]);

    // One hotel batch of the core fails during Alena's approval: 503, nothing written; the same
    // request id then goes through.
    const rid = randomUUID();
    failNext = true;
    const down = await approve(of(sep, 'a')!, '2026-09', rid);
    expect([down.status, down.body.code]).toEqual([503, 'FINANCE_DEPENDENCY_UNAVAILABLE']);
    const up = await approve(of(sep, 'a')!, '2026-09', rid);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body).toMatchObject({ total: '200.00', amountToInvoice: '200.00' });

    const k9 = await approveOk('2026-09', 'k', sep);
    expect(k9).toMatchObject({
      closingBalance: '-200.00',
      amountToInvoice: '0.00',
      carriedForward: '-200.00',
    });
    expect(await mine('k', '2026-09')).toMatchObject({
      state: 'NOTHING_TO_INVOICE',
      amountToInvoice: null,
      balanceCarriedForward: '-200.00',
    });
    // Nothing to invoice → no salesperson invoice.
    const none = await record(k9.id, {
      invoiceNumber: 'K-9',
      issuedOn: '2026-10-05',
      receivedOn: '2026-10-05',
      base: '0.01',
    });
    expect([none.status, none.body.code]).toEqual([422, 'NOTHING_TO_INVOICE']);
  });

  it('October: the carried balance is netted; the invoice received 18. 11. 2026 is paid out 15. 12. 2026', async () => {
    await invoice(f, [h.k1.agreement], '2026-10');
    await invoice(f, [h.k1.agreement], '2026-10');
    await invoice(f, [h.a1.agreement], '2026-10');
    const oct = await preview('2026-10');
    expect(of(oct, 'k')).toMatchObject({
      previousPeriod: '2026-09',
      openingBalance: '-200.00',
      total: '400.00',
      closingBalance: '200.00',
      amountToInvoice: '200.00',
      carriedForward: '0.00',
    });
    // Bohdan has nothing in October: his −100 stays carried (unsettled, O13/O14 proposals).
    expect(of(oct, 'b')).toBeUndefined();
    const a10 = await approveOk('2026-10', 'a', oct);
    await approveOk('2026-10', 'k', oct);
    expect(a10).toMatchObject({
      openingBalance: '0.00',
      total: '200.00',
      amountToInvoice: '200.00',
    });

    // The salesperson's invoice: the base must be the amount to invoice; a number only once.
    const wrong = await record(a10.id, {
      invoiceNumber: 'A-2026-10',
      issuedOn: '2026-11-17',
      receivedOn: '2026-11-18',
      base: '199.99',
    });
    expect([wrong.status, wrong.body.code]).toEqual([422, 'SALESPERSON_INVOICE_BASE_MISMATCH']);
    const reused = await record(a10.id, {
      invoiceNumber: 'A-2026-07',
      issuedOn: '2026-11-17',
      receivedOn: '2026-11-18',
      base: '200.00',
    });
    expect([reused.status, reused.body.code]).toEqual([409, 'SALESPERSON_INVOICE_NUMBER_REUSED']);
    const early = await record(a10.id, {
      invoiceNumber: 'A-2026-10',
      issuedOn: '2026-10-30',
      receivedOn: '2026-10-31',
      base: '200.00',
    });
    expect([early.status, early.body.code]).toEqual([422, 'SALESPERSON_INVOICE_BEFORE_CLOSE']);
    // Two admins at once: one invoice.
    const both = await Promise.all(
      ['A-2026-10', 'A-2026-10x'].map((n) =>
        record(a10.id, {
          invoiceNumber: n,
          issuedOn: '2026-11-17',
          receivedOn: '2026-11-18',
          base: '200.00',
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const ok = both.find((r) => r.status === 200)!;
    expect(ok.body.salespersonInvoice).toMatchObject({
      receivedOn: '2026-11-18',
      payoutOn: '2026-12-15',
    });
    expect(await mine('a', '2026-10')).toEqual({
      month: '2026-10',
      mode: 'TEST',
      state: 'INVOICE_RECEIVED',
      currency: 'CZK',
      amountToInvoice: '200.00',
      balanceCarriedForward: null,
      approvedAt: a10.approvedAt,
      payoutPlannedOn: '2026-12-15',
    });

    // The whole chain per salesperson, approved once each, never changed.
    const [chain] = await withPrivileged(
      (db) =>
        db.$queryRaw<{ n: number; events: number; invoices: number }[]>`
        SELECT count(*)::int AS n,
          (SELECT count(*)::int FROM "finance"."commission_statement_events" e
             JOIN "finance"."commission_statements" s ON s."id" = e."statement_id"
            WHERE s."salesperson_id" = ${people.a.id}::uuid) AS events,
          (SELECT count(*)::int FROM "finance"."commission_salesperson_invoices"
            WHERE "salesperson_id" = ${people.a.id}::uuid) AS invoices
        FROM "finance"."commission_statements" WHERE "salesperson_id" = ${people.a.id}::uuid`,
    );
    // Alena: July, August, September, October; APPROVED ×4 + (invoice + plan) ×2.
    expect(chain).toEqual({ n: 4, events: 8, invoices: 2 });
    for (const [key, st] of Object.entries(approved)) {
      const res = await f.get(`/api/admin/finance/commissions/statements?month=${st.month}`);
      const now = (res.body as { statements: CommissionStatement[] }).statements.find(
        (s) => s.id === st.id,
      );
      expect({ key, ...now, salespersonInvoice: null }).toEqual({
        key,
        ...st,
        salespersonInvoice: null,
      });
    }
  });
});
