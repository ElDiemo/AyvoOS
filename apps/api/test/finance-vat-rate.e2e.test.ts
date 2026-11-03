import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomesticVatRatePage } from '@ayvo/types';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import { domesticVatRateOn } from '../src/finance/vat-rates.js';
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
      // The DB bounds hold without the API as well.
      for (const bad of ['0', '100', '-1'])
        await expect(
          owner.$executeRawUnsafe(
            `INSERT INTO finance.domestic_vat_rates (revision, valid_from, rate_percent, reason, recorded_by, recorded_by_name, request_id)
             VALUES (999999, '2030-01-01', ${bad}, 'x', '${randomUUID()}', 'x', '${randomUUID()}')`,
          ),
        ).rejects.toThrow();
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
    } finally {
      await real.close();
    }
  });
});
