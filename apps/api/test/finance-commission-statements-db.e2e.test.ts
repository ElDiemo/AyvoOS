import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { hasDatabase, withPrivileged } from './support/test-app.js';

/**
 * Sales commissions PR 2b — the database invariants of approved commission statements (doc 069
 * §5, migration 20261119100000_commission_statements). Nothing in the application writes these
 * tables before PR 2c, so the rules are pinned here directly in SQL, as the schema owner (the
 * triggers bind it too): the order and the balance chain, the total of the items, I1, one storno
 * per item, TEST never in LIVE, append-only. Synthetic TEST invoices; random salespeople.
 */
type Tx = Prisma.TransactionClient;

describe.skipIf(!hasDatabase)('Finance: commission statements — database invariants', () => {
  let f: FinanceTestApp;
  let line: { invoiceId: string; number: string; hotelId: string; hotelCode: string };
  let cancelled: { invoiceId: string; number: string; hotelId: string; hotelCode: string };

  const statement = (
    tx: Tx,
    s: {
      id?: string;
      month: string;
      sp: string;
      previous?: string | null;
      opening?: string;
      total: string;
      mode?: string;
    },
  ) => {
    const opening = Number(s.opening ?? '0');
    const closing = opening + Number(s.total);
    const id = s.id ?? randomUUID();
    return tx.$executeRaw`INSERT INTO "finance"."commission_statements"
      ("id", "period_month", "salesperson_id", "salesperson_name", "currency", "mode",
       "previous_statement_id", "opening_balance", "total", "closing_balance", "amount_to_invoice",
       "carried_forward", "fingerprint", "sources_read_at", "approved_by", "approved_by_name", "request_id")
      VALUES (${id}::uuid, ${`${s.month}-01`}::date, ${s.sp}::uuid, 'Obchodník (test)', 'CZK',
       ${s.mode ?? 'TEST'}, ${s.previous ?? null}::uuid, ${opening}::numeric, ${s.total}::numeric,
       ${closing}::numeric, ${Math.max(0, closing)}::numeric, ${Math.min(0, closing)}::numeric,
       repeat('a', 64), now(), ${randomUUID()}::uuid, 'Admin (test)', ${randomUUID()}::uuid)`.then(
      () => id,
    );
  };
  const item = (
    tx: Tx,
    st: string,
    sp: string,
    src: typeof line,
    i: { no?: number; kind?: string; cause?: string; base?: string; amount: string; mode?: string },
  ) =>
    tx.$executeRaw`INSERT INTO "finance"."commission_statement_items"
      ("statement_id", "item_no", "mode", "salesperson_id", "kind", "cause", "invoice_id", "line_no",
       "invoice_number", "service_month", "hotel_id", "hotel_code", "base", "attribution_revision",
       "binding_id", "terms_version", "k", "rate", "amount")
      VALUES (${st}::uuid, ${i.no ?? 1}, ${i.mode ?? 'TEST'}, ${sp}::uuid, ${i.kind ?? 'REGULAR'},
       ${i.cause ?? 'REGULAR'}, ${src.invoiceId}::uuid, 1, ${src.number}, '2026-10-01'::date,
       ${src.hotelId}::uuid, ${src.hotelCode}, ${i.base ?? '1000.00'}::numeric, 1, ${randomUUID()}::uuid,
       1, 3, 20.00, ${i.amount}::numeric)`;
  /** One transaction as the schema owner; resolves to the error message or 'OK'. */
  const attempt = (fn: (tx: Tx) => Promise<unknown>) =>
    withPrivileged((db) => db.$transaction(async (tx) => void (await fn(tx)))).then(
      () => 'OK',
      (e: Error) => e.message,
    );

  beforeAll(async () => {
    f = await createFinanceTestApp();
    const p = await payer(f, 'Plátce DB provizí');
    const x = await hotel(f, `Hotel DB ${randomUUID().slice(0, 6)}`);
    const ag = await agreement(f, p.id, x.id);
    const a = await invoice(f, [ag.code], '2026-10');
    line = { invoiceId: a.id, number: a.number, hotelId: x.id, hotelCode: x.code };
    const y = await hotel(f, `Hotel DB storno ${randomUUID().slice(0, 6)}`);
    const ag2 = await agreement(f, p.id, y.id);
    const c = await invoice(f, [ag2.code], '2026-10');
    cancelled = { invoiceId: c.id, number: c.number, hotelId: y.id, hotelCode: y.code };
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  it('a chain per salesperson: in order, from the latest, the balance carried; the total is the sum of the items', async () => {
    const sp = randomUUID();
    const first = randomUUID();
    expect(
      await attempt(async (tx) => {
        await statement(tx, { id: first, month: '2026-10', sp, total: '200.00' });
        await item(tx, first, sp, line, { amount: '200.00' });
      }),
    ).toBe('OK');
    // A second "first" statement, an earlier or the same month, a wrong previous or opening.
    expect(await attempt((tx) => statement(tx, { month: '2026-11', sp, total: '0.00' }))).toMatch(
      /follows the salesperson's latest statement/,
    );
    expect(
      await attempt((tx) =>
        statement(tx, { month: '2026-09', sp, previous: first, total: '0.00' }),
      ),
    ).toMatch(/never at or before/);
    expect(
      await attempt((tx) =>
        statement(tx, { month: '2026-11', sp, previous: randomUUID(), total: '0.00' }),
      ),
    ).toMatch(/follows the salesperson's latest statement|previous_fkey/);
    expect(
      await attempt((tx) =>
        statement(tx, { month: '2026-11', sp, previous: first, opening: '-10.00', total: '0.00' }),
      ),
    ).toMatch(/carried balance/);
    // The total is the sum of the items, and a statement has at least one (checked at commit).
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, { month: '2026-11', sp, previous: first, total: '50.00' });
        await item(tx, id, sp, cancelled, {
          kind: 'CORRECTION',
          cause: 'CANCELLED',
          base: '0',
          amount: '40.00',
        });
      }),
    ).toMatch(/total is the sum of its items|storno item needs a cancelled invoice/);
    expect(
      await attempt((tx) =>
        statement(tx, { month: '2026-11', sp, previous: first, total: '0.00' }),
      ),
    ).toMatch(/total is the sum of its items \(0 items/);
    // The balance columns are consistent by CHECK.
    expect(
      await attempt(
        (tx) =>
          tx.$executeRaw`INSERT INTO "finance"."commission_statements"
          ("period_month", "salesperson_id", "salesperson_name", "currency", "mode", "opening_balance",
           "total", "closing_balance", "amount_to_invoice", "carried_forward", "fingerprint",
           "sources_read_at", "approved_by", "approved_by_name", "request_id")
          VALUES ('2026-10-01', ${randomUUID()}::uuid, 'X', 'CZK', 'TEST', 0, -5, -5, -5, 0,
           repeat('a', 64), now(), ${randomUUID()}::uuid, 'X', ${randomUUID()}::uuid)`,
      ),
    ).toMatch(/commission_statements_balance_check/);
  });

  it('I1 and one storno per original item; a storno needs a cancelled invoice', async () => {
    // The line of the first test is already a REGULAR item: another one (other salesperson) is refused.
    const other = randomUUID();
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, { month: '2026-10', sp: other, total: '200.00' });
        await item(tx, id, other, line, { amount: '200.00' });
      }),
    ).toMatch(/commission_statement_items_regular_key|Unique constraint/);

    await withPrivileged(
      (db) =>
        db.$executeRaw`INSERT INTO "finance"."invoice_cancellations"
        ("invoice_id", "reason", "cancelled_by", "cancelled_by_name", "request_id")
        VALUES (${cancelled.invoiceId}::uuid, 'syntetické storno', ${randomUUID()}::uuid, 'Test', ${randomUUID()}::uuid)`,
    );
    const sp = randomUUID();
    const first = randomUUID();
    // A REGULAR item of a cancelled invoice is refused.
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, { month: '2026-10', sp, total: '200.00' });
        await item(tx, id, sp, cancelled, { amount: '200.00' });
      }),
    ).toMatch(/valid line at its full amount/);
    // A storno once; the same storno again (any later statement) is refused by the DB.
    expect(
      await attempt(async (tx) => {
        await statement(tx, { id: first, month: '2026-10', sp, total: '-200.00' });
        await item(tx, first, sp, cancelled, {
          kind: 'CORRECTION',
          cause: 'CANCELLED',
          base: '-1000.00',
          amount: '-200.00',
        });
      }),
    ).toBe('OK');
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, {
          month: '2026-11',
          sp,
          previous: first,
          opening: '-200.00',
          total: '-200.00',
        });
        await item(tx, id, sp, cancelled, {
          kind: 'CORRECTION',
          cause: 'CANCELLED',
          base: '-1000.00',
          amount: '-200.00',
        });
      }),
    ).toMatch(/commission_statement_items_cause_key|Unique constraint/);
  });

  it('a LIVE statement never holds a TEST line; an item belongs to its statement', async () => {
    const sp = randomUUID();
    const x = await hotel(f, `Hotel DB live ${randomUUID().slice(0, 6)}`);
    const p = await payer(f, 'Plátce DB live');
    const ag = await agreement(f, p.id, x.id);
    const t = await invoice(f, [ag.code], '2026-10');
    const src = { invoiceId: t.id, number: t.number, hotelId: x.id, hotelCode: x.code };
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, { month: '2026-10', sp, total: '200.00', mode: 'LIVE' });
        await item(tx, id, sp, src, { amount: '200.00', mode: 'LIVE' });
      }),
    ).toMatch(/LIVE commission statement never holds a line of a TEST invoice/);
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, { month: '2026-10', sp, total: '200.00' });
        await item(tx, id, randomUUID(), src, { amount: '200.00' });
      }),
    ).toMatch(/its statement's mode and salesperson/);
  });

  it('a cancellation and an approval of the same invoice are serialised (both orders)', async () => {
    const fresh = async (name: string) => {
      const x = await hotel(f, `Hotel DB souběh ${name} ${randomUUID().slice(0, 6)}`);
      const p = await payer(f, `Plátce souběh ${name}`);
      const ag = await agreement(f, p.id, x.id);
      const v = await invoice(f, [ag.code], '2026-10');
      return { invoiceId: v.id, number: v.number, hotelId: x.id, hotelCode: x.code };
    };
    const cancel = (tx: Tx, invoiceId: string) =>
      tx.$executeRaw`INSERT INTO "finance"."invoice_cancellations"
        ("invoice_id", "reason", "cancelled_by", "cancelled_by_name", "request_id")
        VALUES (${invoiceId}::uuid, 'syntetické storno', ${randomUUID()}::uuid, 'Test', ${randomUUID()}::uuid)`;
    const gate = () => {
      let open!: () => void;
      const done = new Promise<void>((r) => (open = r));
      return { done, open };
    };
    /** Until another connection waits for an advisory lock (the second transaction is blocked). */
    const blocked = async () => {
      for (let i = 0; i < 200; i++) {
        const [r] = await withPrivileged(
          (db) =>
            db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted`,
        );
        if ((r?.n ?? 0) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the second transaction never waited for the lock');
    };
    const approve = (src: typeof line, sp: string) => (tx: Tx) =>
      statement(tx, { month: '2026-10', sp, total: '200.00' }).then((id) =>
        item(tx, id, sp, src, { amount: '200.00' }),
      );

    // 1. The cancellation is first: the approval waits for it and is refused (stale), not booked.
    const a = await fresh('A');
    await withPrivileged(async (db) => {
      const held = gate();
      const inside = gate();
      const first = db.$transaction(
        async (tx) => {
          await cancel(tx, a.invoiceId);
          inside.open();
          await held.done;
        },
        { timeout: 30_000 },
      );
      await inside.done;
      const second = attempt(approve(a, randomUUID()));
      await blocked();
      held.open();
      await first;
      expect(await second).toMatch(/valid line at its full amount/);
    });

    // 2. The approval is first: the cancellation waits and then commits; the booked REGULAR item
    //    stays and its storno is a CANCELLED correction of a later statement (once).
    const b = await fresh('B');
    const sp = randomUUID();
    const firstId = randomUUID();
    await withPrivileged(async (db) => {
      const held = gate();
      const inside = gate();
      const first = db.$transaction(
        async (tx) => {
          await statement(tx, { id: firstId, month: '2026-10', sp, total: '200.00' });
          await item(tx, firstId, sp, b, { amount: '200.00' });
          inside.open();
          await held.done;
        },
        { timeout: 30_000 },
      );
      await inside.done;
      const second = attempt((tx) => cancel(tx, b.invoiceId));
      await blocked();
      held.open();
      await first;
      expect(await second).toBe('OK');
    });
    expect(
      await attempt(async (tx) => {
        const id = await statement(tx, {
          month: '2026-11',
          sp,
          previous: firstId,
          total: '-200.00',
        });
        await item(tx, id, sp, b, {
          kind: 'CORRECTION',
          cause: 'CANCELLED',
          base: '-1000.00',
          amount: '-200.00',
        });
      }),
    ).toBe('OK');
  }, 60_000);

  it('append-only, also for the schema owner; the runtime role may not change a row', async () => {
    for (const sql of [
      `UPDATE "finance"."commission_statements" SET "salesperson_name" = 'X'`,
      `DELETE FROM "finance"."commission_statement_items"`,
      `TRUNCATE "finance"."commission_statement_events"`,
    ])
      expect(await attempt((tx) => tx.$executeRawUnsafe(sql))).toMatch(
        /not allowed \(immutable record\)/,
      );
    const grants = await withPrivileged(
      (db) =>
        db.$queryRaw<{ table_name: string; privilege_type: string }[]>`
        SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'ayvo_finance_rw' AND table_name LIKE 'commission_statement%'
        ORDER BY table_name, privilege_type`,
    );
    expect(grants).toEqual(
      [
        'commission_statement_events',
        'commission_statement_items',
        'commission_statements',
      ].flatMap((table_name) => [
        { table_name, privilege_type: 'INSERT' },
        { table_name, privilege_type: 'SELECT' },
      ]),
    );
  });
});
