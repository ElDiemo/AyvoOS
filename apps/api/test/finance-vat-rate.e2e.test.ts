import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomesticVatRatePage } from '@ayvo/types';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import { domesticVatRateOn, effectiveVatRates, vatRateOn } from '../src/finance/vat-rates.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase } from './support/test-app.js';

/**
 * The default VAT rate of domestic invoices (owner 2026-11-03, doc 040 §17): no default (none →
 * nothing applies), entered in percent and valid from a day, versions with a reason made from the
 * newest one seen, a correction of a start day by a later revision, the selection by a tax point
 * (the contract for live issuing), append-only in the DB, finance:issuer_manage only. The rates
 * are one per installation: the cases build on each other in order. Synthetic values only.
 */
const S = '/api/admin/finance/issuer/vat-rates';

describe.skipIf(!hasDatabase)('finance default domestic VAT rate (doc 040 §17)', () => {
  let f: FinanceTestApp;
  let runtime: PrismaClient;
  beforeAll(async () => {
    f = await createFinanceTestApp();
    runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
  });
  afterAll(async () => {
    await runtime?.$disconnect();
    await f?.close();
  });

  const rate = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    expectedRevision: null,
    validFrom: '2026-01-01',
    ratePercent: '21',
    reason: 'Sazba podle správce (test)',
    ...over,
  });
  const page = async () => (await f.get(S).expect(200)).body as DomesticVatRatePage;
  const on = (day: string) => runtime.$transaction((tx) => domesticVatRateOn(tx, day));

  it('without a rate nothing applies; nothing is assumed', async () => {
    const p = await page();
    expect(p).toMatchObject({ current: null, effective: [], versions: [] });
    expect(p.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await on('2026-11-03')).toBeNull();
  });

  it('every value is required: percent with at most two decimals, more than 0, less than 100', async () => {
    for (const bad of [
      { ratePercent: '' },
      { ratePercent: '0' },
      { ratePercent: '0.00' },
      { ratePercent: '100' },
      { ratePercent: '21.005' },
      { ratePercent: '21,5' },
      { ratePercent: '-21' },
      { ratePercent: 'abc' },
      { ratePercent: undefined },
      { validFrom: '' },
      { validFrom: '2026-02-30' },
      { validFrom: undefined },
      { reason: '' },
      { extra: true },
    ])
      await f.post(S).send(rate(bad)).expect(400);
    expect((await page()).versions).toEqual([]);
  });

  it('a rate from a day; replayed once; a form that saw another revision is refused', async () => {
    const first = rate({ ratePercent: '21' });
    const created = (await f.post(S).send(first).expect(201)).body as DomesticVatRatePage;
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]).toMatchObject({
      validFrom: '2026-01-01',
      ratePercent: '21.00',
      reason: 'Sazba podle správce (test)',
    });
    expect(created.versions[0]!.recordedByName).toBeTruthy();
    // Replayed: the same answer, nothing twice.
    expect((await f.post(S).send(first).expect(201)).body).toEqual(created);
    const stale = await f.post(S).send(rate({ validFrom: '2027-01-01', ratePercent: '12' }));
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    expect((await page()).versions).toHaveLength(1);
  });

  it('selected by the tax point: the latest start day not after it; a correction of a day wins', async () => {
    let p = await page();
    // A later rate, from 2027-01-01 (synthetic value).
    p = (
      await f
        .post(S)
        .send(
          rate({
            expectedRevision: p.versions[0]!.revision,
            validFrom: '2027-01-01',
            ratePercent: '19.5',
            reason: 'Nová sazba od roku 2027 (test)',
          }),
        )
        .expect(201)
    ).body as DomesticVatRatePage;
    expect(await on('2025-12-31')).toBeNull();
    expect((await on('2026-01-01'))?.ratePercent).toBe('21.00');
    expect((await on('2026-12-31'))?.ratePercent).toBe('21.00');
    expect((await on('2027-01-01'))?.ratePercent).toBe('19.50');
    // A correction of the 2027 start day: a new revision, the history keeps both.
    p = (
      await f
        .post(S)
        .send(
          rate({
            expectedRevision: p.versions[0]!.revision,
            validFrom: '2027-01-01',
            ratePercent: '19.75',
            reason: 'Oprava překlepu (test)',
          }),
        )
        .expect(201)
    ).body as DomesticVatRatePage;
    expect((await on('2027-06-30'))?.ratePercent).toBe('19.75');
    expect(p.versions.map((v) => v.ratePercent)).toEqual(['19.75', '19.50', '21.00']);
    expect(p.effective.map((v) => [v.validFrom, v.ratePercent])).toEqual([
      ['2027-01-01', '19.75'],
      ['2026-01-01', '21.00'],
    ]);
    // Today (Prague) by the same rule.
    const expected = p.effective.find((r) => r.validFrom <= p.today) ?? null;
    expect(p.current).toEqual(expected);
  });

  it('the newest correction of the selected day wins over newer revisions of earlier or later days', async () => {
    let p = await page();
    const add = async (validFrom: string, ratePercent: string) =>
      (p = (
        await f
          .post(S)
          .send(
            rate({
              expectedRevision: p.versions[0]!.revision,
              validFrom,
              ratePercent,
              reason: `Sazba od ${validFrom} (test)`,
            }),
          )
          .expect(201)
      ).body as DomesticVatRatePage);
    // In revision order: 2028-01 10, 2028-07 11, a correction of 2028-07 11.5, then (newer still)
    // a correction of the earlier 2028-01 and a later start 2029-01.
    await add('2028-01-01', '10');
    await add('2028-07-01', '11');
    await add('2028-07-01', '11.5');
    await add('2028-01-01', '10.5');
    await add('2029-01-01', '13');
    expect((await on('2028-08-01'))?.ratePercent).toBe('11.50');
    expect((await on('2028-07-01'))?.ratePercent).toBe('11.50');
    expect((await on('2028-06-30'))?.ratePercent).toBe('10.50');
    expect((await on('2028-12-31'))?.ratePercent).toBe('11.50');
    expect((await on('2029-01-01'))?.ratePercent).toBe('13.00');
    // The page by the same rule.
    expect(p.effective.slice(0, 3).map((v) => [v.validFrom, v.ratePercent])).toEqual([
      ['2029-01-01', '13.00'],
      ['2028-07-01', '11.50'],
      ['2028-01-01', '10.50'],
    ]);
  });

  it('a future rate is withdrawn by a confirmed new revision; the previous day applies, never an older revision', async () => {
    const W = `${S}/withdrawals`;
    let p = await page();
    const add = async (validFrom: string, ratePercent: string) =>
      (p = (
        await f
          .post(S)
          .send(rate({ expectedRevision: p.versions[0]!.revision, validFrom, ratePercent }))
          .expect(201)
      ).body as DomesticVatRatePage);
    // A future day with a correction: withdrawing it must not bring back the older 12.
    await add('2099-01-01', '12');
    await add('2099-01-01', '12.5');
    const withdraw = (over: Record<string, unknown> = {}) => ({
      requestId: randomUUID(),
      expectedRevision: p.versions[0]!.revision,
      validFrom: '2099-01-01',
      reason: 'Naplánováno omylem (test)',
      confirm: true,
      ...over,
    });
    // Explicit: confirmed, with a reason, from the revision seen.
    for (const bad of [
      { confirm: undefined },
      { confirm: false },
      { reason: '' },
      { expectedRevision: null },
      { validFrom: '2099-02-30' },
      { extra: true },
    ])
      await f.post(W).send(withdraw(bad)).expect(400);
    const stale = await f.post(W).send(withdraw({ expectedRevision: p.versions[1]!.revision }));
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    // Only a start day still in the future (Prague): not today, not one that applies already.
    for (const validFrom of [p.today, '2026-01-01']) {
      const r = await f.post(W).send(withdraw({ validFrom }));
      expect([r.status, r.body.code]).toEqual([409, 'VAT_RATE_NOT_FUTURE']);
    }
    const nothing = await f.post(W).send(withdraw({ validFrom: '2097-05-05' }));
    expect([nothing.status, nothing.body.code]).toEqual([409, 'VAT_RATE_NOTHING_TO_WITHDRAW']);
    expect((await page()).versions).toHaveLength(p.versions.length);

    const request = withdraw();
    const done = (await f.post(W).send(request).expect(201)).body as DomesticVatRatePage;
    // Replayed: the same answer, nothing twice.
    expect((await f.post(W).send(request).expect(201)).body).toEqual(done);
    expect(done.versions).toHaveLength(p.versions.length + 1);
    expect(done.versions[0]).toMatchObject({
      validFrom: '2099-01-01',
      kind: 'WITHDRAWAL',
      ratePercent: null,
      reason: 'Naplánováno omylem (test)',
    });
    expect(done.versions[0]!.recordedByName).toBeTruthy();
    // The history keeps both rates of the day; none of them applies.
    expect(done.versions.filter((v) => v.validFrom === '2099-01-01')).toHaveLength(3);
    expect(done.effective.map((v) => v.validFrom)).not.toContain('2099-01-01');
    expect((await on('2099-06-01'))?.ratePercent).toBe('13.00');
    expect((await on('2029-06-01'))?.ratePercent).toBe('13.00');
    // Nothing left to withdraw on that day.
    p = done;
    const again = await f.post(W).send(withdraw());
    expect([again.status, again.body.code]).toEqual([409, 'VAT_RATE_NOTHING_TO_WITHDRAW']);
    // A new rate of the day afterwards is a new revision, chosen as such.
    await add('2099-01-01', '14');
    expect((await on('2099-06-01'))?.ratePercent).toBe('14.00');
    expect(p.effective[0]).toMatchObject({ validFrom: '2099-01-01', ratePercent: '14.00' });
  });

  it('rates are append-only, also for the schema owner', async () => {
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      await expect(
        owner.$executeRawUnsafe(`UPDATE finance.domestic_vat_rates SET rate_percent = 1`),
      ).rejects.toThrow();
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM finance.domestic_vat_rates`),
      ).rejects.toThrow();
      await expect(
        owner.$executeRawUnsafe(`TRUNCATE finance.domestic_vat_rates`),
      ).rejects.toThrow();
      // The DB bounds hold without the API as well — and more than two decimals are refused,
      // never rounded first (no typmod: numeric(5,2) would store 21.123 as 21.12).
      const insert = (
        db: Pick<PrismaClient, '$executeRawUnsafe'>,
        value: string,
        kind = 'RATE',
        validFrom = '2030-01-01',
      ) =>
        db.$executeRawUnsafe(
          `INSERT INTO finance.domestic_vat_rates (revision, valid_from, kind, rate_percent, reason, recorded_by, recorded_by_name, request_id)
           VALUES (999999, '${validFrom}', '${kind}', ${value}, 'x', '${randomUUID()}', 'x', '${randomUUID()}')`,
        );
      for (const bad of ['0', '100', '-1', '21.123', '21.005', '21.100', `'21.999'`, '99.995'])
        await expect(insert(owner, bad)).rejects.toThrow();
      for (const bad of ['21.123', '21.100']) await expect(insert(runtime, bad)).rejects.toThrow();
      // The same statement with two decimals is stored exactly as given, by both roles (inside a
      // transaction that is rolled back): the refusals above are the value's, nothing else.
      const rollback = new Error('rollback');
      for (const db of [owner, runtime])
        await expect(
          db.$transaction(async (tx) => {
            await insert(tx, '21.5');
            const [row] = await tx.$queryRawUnsafe<{ v: string }[]>(
              `SELECT rate_percent::text AS v FROM finance.domestic_vat_rates WHERE revision = 999999`,
            );
            expect(row?.v).toBe('21.5');
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      const [column] = await owner.$queryRawUnsafe<{ p: number | null; s: number | null }[]>(
        `SELECT numeric_precision AS p, numeric_scale AS s FROM information_schema.columns
          WHERE table_schema = 'finance' AND table_name = 'domestic_vat_rates' AND column_name = 'rate_percent'`,
      );
      expect(column).toEqual({ p: null, s: null });
      // A rate always has a value, a withdrawal never; a withdrawal only of a future day that has
      // a rate — also without the API (2026-01-01 has passed, 2031-05-05 has no rate).
      await expect(insert(owner, 'NULL')).rejects.toThrow();
      await expect(insert(owner, '21', 'WITHDRAWAL', '2099-01-01')).rejects.toThrow();
      await expect(insert(owner, 'NULL', 'WITHDRAWAL', '2026-01-01')).rejects.toThrow(/future/);
      await expect(insert(owner, 'NULL', 'WITHDRAWAL', '2031-05-05')).rejects.toThrow(
        /no VAT rate/,
      );
      await expect(insert(runtime, 'NULL', 'WITHDRAWAL', '2026-01-01')).rejects.toThrow(/future/);
      await expect(insert(owner, 'NULL', 'OTHER', '2099-01-01')).rejects.toThrow();
    } finally {
      await owner.$disconnect();
    }
  });

  it('reading and changing need finance:issuer_manage', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const roleCode = `FINV_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Jen smlouvy (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.create({
        data: { roleCode, permissionCode: 'finance:billing_manage' },
      });
      const user = await prepareInvitedUser(real.core, {
        email: `vat-rate-${randomUUID()}@ayvo.test`,
        displayName: 'Jen smlouvy',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode, grantReason: 'test: no issuer settings' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      await real.get(S, cookie).expect(403);
      await real.post(S, cookie).send(rate()).expect(403);
      await real
        .post(`${S}/withdrawals`, cookie)
        .send({
          requestId: randomUUID(),
          expectedRevision: 1,
          validFrom: '2099-01-01',
          reason: 'test',
          confirm: true,
        })
        .expect(403);
    } finally {
      await real.close();
    }
  });
});

describe('the effective rates without a database (doc 040 §17)', () => {
  const v = (revision: number, validFrom: string, ratePercent: string | null) => ({
    revision,
    validFrom,
    kind: ratePercent === null ? ('WITHDRAWAL' as const) : ('RATE' as const),
    ratePercent,
    reason: 'test',
    recordedAt: '2026-11-03T08:00:00.000Z',
    recordedByName: 'test',
  });
  it('a withdrawn only start day leaves no rate at all', () => {
    const effective = effectiveVatRates([v(2, '2099-01-01', null), v(1, '2099-01-01', '21.00')]);
    expect(effective).toEqual([]);
    expect(vatRateOn(effective, '2099-06-01')).toBeNull();
  });
  it('a withdrawn day hands over to the previous day, never to its own older revision', () => {
    const effective = effectiveVatRates([
      v(1, '2098-01-01', '20.00'),
      v(2, '2099-01-01', '21.00'),
      v(3, '2099-01-01', '22.00'),
      v(4, '2099-01-01', null),
    ]);
    expect(vatRateOn(effective, '2099-06-01')?.ratePercent).toBe('20.00');
  });
});
