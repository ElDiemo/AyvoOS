import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { commissionPreviewSchema, type AdminUserDetail, type CommissionPreview } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';

/**
 * Sales commissions PR 2b — the Finance preview of a monthly commission closing (doc 069 §5;
 * owner approved doc 069 §3–§6 and O1–O16 for the first DEV version, 2026-11-18). Finance as it
 * runs: its own app and DB role, the core over real HTTP with the service token. Synthetic TEST
 * invoices only. The preview reads Finance's lines and the core contract (§4) and writes nothing.
 * Other test files share the database (other invoices exist): assertions name our own people
 * and hotels.
 */
const MONTH = '2026-10';

describe.skipIf(!hasDatabase)('Finance: commission closing preview (doc 069 §5)', () => {
  let f: FinanceTestApp;
  let proxy: Server;
  /** Requests to commissions/attributions through the proxy: hotelIds per call. */
  const calls: number[] = [];
  let failCall: number | null = null;
  const people: Record<'a' | 'b' | 'c', { id: string; name: string }> = {} as never;
  const tag = randomUUID().slice(0, 6);
  const core = () => request(f.core.app.getHttpServer());
  const SU = 'ayvo_session=finance-test-session';
  const preview = (query: Record<string, string>) =>
    f.get(`/api/admin/finance/commissions/preview?${new URLSearchParams(query)}`);
  const read = async (month = MONTH) => {
    const res = await preview({ month });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return commissionPreviewSchema.parse(res.body) as CommissionPreview;
  };
  const counts = () =>
    withPrivileged(async (db) => {
      const [r] = await db.$queryRaw<{ s: bigint; i: bigint; e: bigint; o: bigint }[]>`
        SELECT (SELECT count(*) FROM "finance"."commission_statements") AS s,
               (SELECT count(*) FROM "finance"."commission_statement_items") AS i,
               (SELECT count(*) FROM "finance"."commission_statement_events") AS e,
               (SELECT count(*) FROM "finance"."operation_requests") AS o`;
      return r;
    });

  async function salesperson(name: string) {
    const res = await core()
      .post('/api/admin/identity/users')
      .set('Cookie', SU)
      .send({
        email: `fcp-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: `${name} ${tag}`,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'commissions',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: (res.body as AdminUserDetail).id, name: `${name} ${tag}` };
  }
  const terms = async (salespersonId: string, rates: object) => {
    const res = await core()
      .post('/api/admin/sales/commission-terms')
      .set('Cookie', SU)
      .send({
        requestId: randomUUID(),
        salespersonId,
        expectedVersion: 0,
        reason: 'smlouva',
        confirm: true,
        ...rates,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const attribute = async (code: string, salespersonId: string | null, commissionStart: string) => {
    const res = await core()
      .post(`/api/admin/hotels/${code}/sales-attribution`)
      .set('Cookie', SU)
      .send({
        requestId: randomUUID(),
        expectedRevision: 0,
        source: 'MANUAL',
        reason: 'stávající hotel',
        confirm: true,
        salespersonId,
        commissionStart,
        confirmCommissionStart: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const cancel = (invoiceId: string) =>
    withPrivileged(
      (db) =>
        db.$executeRaw`INSERT INTO "finance"."invoice_cancellations"
        ("invoice_id", "reason", "cancelled_by", "cancelled_by_name", "request_id")
        VALUES (${invoiceId}::uuid, 'syntetické storno', ${randomUUID()}::uuid, 'Test', ${randomUUID()}::uuid)`,
    );

  const h: Record<string, { id: string; code: string; agreement: string }> = {};
  const inv: Record<string, { id: string; number: string }> = {};

  beforeAll(async () => {
    // A proxy in front of the core: it counts the contract's batches and can fail one of them.
    // It forwards to the core of `f`, created right after with the proxy as its core URL.
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url?.endsWith('/commissions/attributions')) {
          calls.push((JSON.parse(body.toString()) as { hotelIds: string[] }).hotelIds.length);
          if (failCall !== null && calls.length === failCall) {
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

    people.a = await salesperson('Alena Fiktivní');
    people.b = await salesperson('Bohdan Smyšlený');
    people.c = await salesperson('Cyril Bezpodmínek');
    await terms(people.a.id, { initialRate: '20', initialMonths: 24, maintenanceRate: '5' });
    await terms(people.b.id, { initialRate: '10', initialMonths: 36, maintenanceRate: '3' });

    const p = await payer(f, `Plátce provize ${tag}`);
    for (const key of ['a', 'b', 'house', 'none', 'early', 'noTerms']) {
      const x = await hotel(f, `Hotel ${key} ${tag}`);
      const ag = await agreement(f, p.id, x.id);
      h[key] = { id: x.id, code: x.code, agreement: ag.code };
    }
    await attribute(h.a!.code, people.a.id, '2026-08');
    await attribute(h.b!.code, people.b.id, '2026-08');
    await attribute(h.house!.code, null, '2026-08');
    await attribute(h.early!.code, people.a.id, '2026-12');
    await attribute(h.noTerms!.code, people.c.id, '2026-08');
    // Each line is 1 000.00 (fixture). One invoice per hotel, plus a summary invoice of two.
    inv.a = await invoice(f, [h.a!.agreement], MONTH);
    inv.aCancelled = await invoice(f, [h.a!.agreement], '2026-09');
    inv.summary = await invoice(f, [h.b!.agreement, h.house!.agreement], MONTH);
    inv.none = await invoice(f, [h.none!.agreement], MONTH);
    inv.early = await invoice(f, [h.early!.agreement], MONTH);
    inv.noTerms = await invoice(f, [h.noTerms!.agreement], MONTH);
    inv.nov = await invoice(f, [h.a!.agreement], '2026-11');
    await cancel(inv.aCancelled.id);
  }, 120_000);
  afterAll(async () => {
    await f?.close();
    await new Promise((resolve) => proxy?.close(resolve));
  });

  const own = (p: CommissionPreview) => {
    const ids = new Set(Object.values(people).map((x) => x.id));
    return p.statements.filter((s) => ids.has(s.salesperson.id));
  };

  it('per salesperson from the billed period: k and the bound rate; a summary invoice splits; Firemní hotel, cancelled and other months excluded', async () => {
    const before = await counts();
    const p = await read();
    const st = Object.fromEntries(own(p).map((s) => [s.salesperson.name, s]));
    expect(Object.keys(st).sort()).toEqual([people.a.name, people.b.name, people.c.name].sort());
    // Alena: October = k 3 at 20 % of 1 000.00; the cancelled September and November are not in.
    expect(st[people.a.name]!.items).toEqual([
      expect.objectContaining({
        kind: 'REGULAR',
        cause: 'REGULAR',
        invoiceNumber: inv.a!.number,
        hotelCode: h.a!.code,
        serviceMonth: MONTH,
        base: '1000.00',
        k: 3,
        rate: '20.00',
        amount: '200.00',
        attributionRevision: 1,
        termsVersion: 1,
      }),
    ]);
    expect(st[people.a.name]).toMatchObject({
      currency: 'CZK',
      previousPeriod: null,
      openingBalance: '0.00',
      total: '200.00',
      closingBalance: '200.00',
      amountToInvoice: '200.00',
      carriedForward: '0.00',
      flags: [],
    });
    // The summary invoice: Bohdan's line counts, the company hotel's line never.
    expect(
      st[people.b.name]!.items.map((i) => [i.invoiceNumber, i.hotelCode, i.rate, i.amount]),
    ).toEqual([[inv.summary!.number, h.b!.code, '10.00', '100.00']]);
    expect(p.statements.some((s) => s.items.some((i) => i.hotelCode === h.house!.code))).toBe(
      false,
    );
    // Cyril has no terms: flagged, nothing computed.
    expect(st[people.c.name]).toMatchObject({ items: [], total: '0.00' });
    expect(st[people.c.name]!.flags.map((x) => [x.code, x.hotelCode])).toEqual([
      ['TERMS_MISSING', h.noTerms!.code],
    ]);
    // Unassigned and before the start are listed, never blocking anyone.
    const mine = p.unresolved.filter((u) => [h.none!.code, h.early!.code].includes(u.hotelCode));
    expect(mine.map((u) => [u.reason, u.hotelCode, u.serviceMonth]).sort()).toEqual(
      [
        ['BEFORE_COMMISSION_START', h.early!.code, MONTH],
        ['UNASSIGNED', h.none!.code, MONTH],
      ].sort(),
    );
    // Read-only and deterministic.
    expect(await read()).toEqual(p);
    expect(await counts()).toEqual(before);
  });

  it('only a closed month; LIVE has nothing until a live invoice kind exists (O1)', async () => {
    // The current month in Prague is never closed (not a fixed month: the test outlives it).
    const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' })
      .format(new Date())
      .slice(0, 7);
    const open = await preview({ month: current });
    expect([open.status, open.body.code]).toEqual([422, 'MONTH_NOT_CLOSED']);
    expect((await preview({ month: '2099-01' })).status).toBe(422);
    const live = await preview({ month: MONTH, mode: 'LIVE' });
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ month: MONTH, mode: 'LIVE', statements: [], unresolved: [] });
    const bad: Record<string, string>[] = [
      { month: '2026-13' },
      { month: MONTH, mode: 'PROD' },
      { month: MONTH, extra: '1' },
    ];
    for (const q of bad) expect((await preview(q)).status, JSON.stringify(q)).toBe(400);
  });

  it('the core contract in batches of ≤ 200; a failed batch is 503 and nothing partial', async () => {
    // 201 more hotels billed in one month (unknown to the core: they come back unassigned).
    const month = '2026-04';
    const digits = (n: number) =>
      Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
    const number = `T${digits(4)}-${digits(5)}`;
    await withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        const id = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO "finance"."invoices" ("id", "serial", "kind", "number", "variable_symbol",
             "customer_id", "customer_version", "period_month", "issued_on", "due_on", "currency",
             "total", "snapshot", "pdf_storage_key", "pdf_sha256", "issued_by", "issued_by_name", "request_id")
           VALUES ($1::uuid, $2, 'TEST', $3, $4, $5::uuid, 1, $6::date, current_date, current_date + 14,
             'CZK', 201000.00, '{}'::jsonb, $7, repeat('0', 64), $5::uuid, 'Syntetický test', $8::uuid)`,
          id,
          BigInt(800_000_000 + Math.floor(Math.random() * 99_000_000)),
          number,
          `8${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
          randomUUID(),
          `${month}-01`,
          `batch-${tag}.pdf`,
          randomUUID(),
        );
        for (let n = 1; n <= 201; n++)
          await tx.$executeRawUnsafe(
            `INSERT INTO "finance"."invoice_lines" ("invoice_id", "line_no", "agreement_id",
               "agreement_revision", "period_month", "hotel_id", "hotel_code", "hotel_name",
               "billed_rooms", "unit_price", "amount")
             VALUES ($1::uuid, $2, $3::uuid, 1, $4::date, $3::uuid, $5, 'Dávkový hotel', 10, 100.00, 1000.00)`,
            id,
            n,
            randomUUID(),
            `${month}-01`,
            `HT-B${n}`,
          );
      }),
    );
    calls.length = 0;
    const p = await read(month);
    // Every billed month ≤ April is read; April itself has ≥ 201 hotels → ≥ 2 batches, none > 200.
    expect(Math.max(...calls)).toBeLessThanOrEqual(200);
    expect(calls.filter((n) => n === 200).length).toBeGreaterThanOrEqual(1);
    expect(p.unresolved.filter((u) => u.invoiceNumber === number)).toHaveLength(201);

    // The second batch fails: 503, no statement, nothing written.
    const before = await counts();
    calls.length = 0;
    failCall = 2;
    const down = await preview({ month });
    failCall = null;
    expect([down.status, down.body.code]).toEqual([503, 'FINANCE_DEPENDENCY_UNAVAILABLE']);
    expect(down.body.statements).toBeUndefined();
    expect(calls.length).toBe(2); // stopped at the failed batch; a 500 is never retried
    expect(await counts()).toEqual(before);
  });

  it('only finance:commissions_manage (ADMIN): a salesperson is refused, no session is 401', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const user = await prepareInvitedUser(real.core, {
        email: `fcp-sales-${randomUUID()}@ayvo.test`,
        displayName: 'Obchodník bez Financí',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test: salesperson' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      const path = `/api/admin/finance/commissions/preview?month=${MONTH}`;
      expect((await real.get(path, cookie)).status).toBe(403);
      await request(real.app.getHttpServer()).get(path).expect(401);
    } finally {
      await real.close();
    }
  });
});
