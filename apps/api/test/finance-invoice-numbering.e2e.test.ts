import { HttpException } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  allocateHotelInvoiceNumber,
  hotelInvoiceCounter,
  hotelInvoiceNumber,
} from '../src/finance/invoice-numbering.js';
import { financeDatabaseUrl, financeOwnerDatabaseUrl } from './support/finance-app.js';
import { hasDatabase } from './support/test-app.js';

/**
 * The number series of issued hotel invoices (owner 2026-11-03, doc 040 §16), on the real Finance
 * database as its runtime role: allocated inside the transaction (a rolled-back attempt hands the
 * same number to the next one), concurrent issues get distinct consecutive numbers, a counter of
 * its own per year of issue (never the billed period), refused after 99 999, and the TEST series
 * untouched. Each case uses its own year, so the order of the cases does not matter.
 */
describe('hotel invoice number (doc 040 §16)', () => {
  it('year of issue + series 1 + five digits; ten digits, the same as the VS', () => {
    expect(hotelInvoiceNumber(2026, 1, 1n)).toBe('2026100001');
    expect(hotelInvoiceNumber(2026, 1, 99_999n)).toBe('2026199999');
    expect(hotelInvoiceNumber(2027, 1, 42n)).toMatch(/^\d{10}$/);
    // Never a TEST number (T<year>-<5>) nor a TEST VS (99<year><4>).
    expect(hotelInvoiceNumber(2026, 1, 1n)).not.toMatch(/^T|^99/);
    for (const [y, s, n] of [
      [2026, 1, 0n],
      [2026, 1, 100_000n],
      [2026, 0, 1n],
      [2026, 10, 1n],
      [999, 1, 1n],
      [10_000, 1, 1n],
    ] as const)
      expect(() => hotelInvoiceNumber(y, s, n)).toThrow();
  });
});

describe.skipIf(!hasDatabase)('hotel invoice numbers on the database (doc 040 §16)', () => {
  let runtime: PrismaClient;
  let owner: PrismaClient;
  let testSeriesBefore: bigint;
  const testSeries = async () =>
    (await owner.codeCounter.findUniqueOrThrow({ where: { name: 'invoice_test' } })).lastValue;
  const allocate = (issuedOn: string) =>
    runtime.$transaction((tx) => allocateHotelInvoiceNumber(tx, issuedOn));
  const counter = async (year: number) =>
    (await owner.codeCounter.findUnique({ where: { name: hotelInvoiceCounter(year, 1) } }))
      ?.lastValue ?? null;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    // The runtime role of Finance, as the API uses it — its grants are part of the check.
    runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    testSeriesBefore = await testSeries();
  });
  afterAll(async () => {
    // The TEST series is its own: no live allocation moved it.
    expect(await testSeries()).toBe(testSeriesBefore);
    await runtime?.$disconnect();
    await owner?.$disconnect();
  });

  it('the first number of a year; the VS is the number', async () => {
    expect(await counter(2026)).toBeNull();
    expect(await allocate('2026-11-03')).toEqual({
      number: '2026100001',
      variableSymbol: '2026100001',
      year: 2026,
      sequence: 1n,
    });
  });

  it('concurrent issues: distinct, consecutive, none twice', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        runtime.$transaction(
          async (tx) => {
            const n = await allocateHotelInvoiceNumber(tx, '2026-11-04');
            await pause(20); // the rest of the issue, holding the counter row
            return n.number;
          },
          { timeout: 30_000, maxWait: 30_000 },
        ),
      ),
    );
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => hotelInvoiceNumber(2026, 1, BigInt(i + 2))),
    );
  });

  it('a refused or failed issue hands its number to the next attempt; no gap, never two', async () => {
    const failed = runtime.$transaction(async (tx) => {
      const n = await allocateHotelInvoiceNumber(tx, '2030-03-01');
      await pause(300); // a second issue waits for the counter row meanwhile
      throw new Error(`the PDF could not be stored (${n.number})`);
    });
    await pause(50);
    const next = allocate('2030-03-01');
    await expect(failed).rejects.toThrow('(2030100001)');
    expect((await next).number).toBe('2030100001');
    // The retry of the failed one gets the following number: 2030100001 is issued now.
    expect((await allocate('2030-03-01')).number).toBe('2030100002');
  });

  it('the year turns: a counter of its own from 00001; the old year continues apart', async () => {
    expect((await allocate('2027-12-31')).number).toBe('2027100001');
    expect((await allocate('2028-01-01')).number).toBe('2028100001');
    expect((await allocate('2028-01-02')).number).toBe('2028100002');
    expect(await counter(2027)).toBe(1n);
  });

  it('the year of issue decides, never the billed period', async () => {
    // December 2028 billed, issued on 5 January 2029: a 2029 number.
    expect((await allocate('2029-01-05')).number).toBe('2029100001');
    expect(await counter(2029)).toBe(1n);
  });

  it('after 99 999 in a year: refused, nothing changes; another year is not affected', async () => {
    await owner.codeCounter.create({
      data: { name: hotelInvoiceCounter(2035, 1), lastValue: 99_998n },
    });
    expect((await allocate('2035-06-30')).number).toBe('2035199999');
    const full = await allocate('2035-07-01').catch((e: unknown) => e);
    expect(full).toBeInstanceOf(HttpException);
    expect((full as HttpException).getStatus()).toBe(409);
    expect((full as HttpException).getResponse()).toMatchObject({ code: 'NUMBER_SERIES_FULL' });
    expect(await counter(2035)).toBe(99_999n);
    expect((await allocate('2036-01-01')).number).toBe('2036100001');
  });

  it('refuses what is not a date of issue', async () => {
    await expect(allocate('2026-11')).rejects.toThrow('Not a date');
  });
});
