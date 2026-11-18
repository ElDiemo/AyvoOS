import type { FinanceCommissionHotel } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import {
  cents,
  closedBy,
  commission,
  computeClosing,
  money,
  type BookedItem,
  type ClosingInput,
  type ClosingLine,
  type LatestStatement,
} from './commission-closing.js';

/**
 * The scenarios of the approved isolated model (doc 069 §8, #195 21fb92c, 24/24) that concern
 * the preview, on the production calculation. Synthetic data only.
 */
const A = { salespersonId: '00000000-0000-4000-8000-00000000000a', displayName: 'Alena Fiktivní' };
const B = { salespersonId: '00000000-0000-4000-8000-00000000000b', displayName: 'Bohdan Smyšlený' };
const plan = (id: string, i: string, n: number, m: string) => ({
  bindingId: id,
  termsVersion: 1,
  initialRate: i,
  initialMonths: n,
  maintenanceRate: m,
});
const hotelAnswer = (
  hotelId: string,
  recipient: typeof A | null,
  binding: ReturnType<typeof plan> | null,
  start = '2027-06',
  revision = 1,
): FinanceCommissionHotel => ({
  hotelId,
  commissionStart: start,
  attribution: { revision, effectiveFrom: start, commissionStart: start, recipient, binding },
});

let seq = 0;
function line(over: Partial<ClosingLine>): ClosingLine {
  seq += 1;
  return {
    invoiceId: `inv-${seq}`,
    invoiceNumber: `T2027-${String(seq).padStart(5, '0')}`,
    invoiceKind: 'TEST',
    currency: 'CZK',
    lineNo: 1,
    periodMonth: '2027-07',
    hotelId: 'h-1',
    hotelCode: 'HT-000001',
    amount: '4820.00',
    cancelled: false,
    ...over,
  };
}
const answersOf = (
  per: (hotelId: string, month: string) => FinanceCommissionHotel | null,
  lines: ClosingLine[],
) => {
  const out = new Map<string, Map<string, FinanceCommissionHotel>>();
  for (const l of lines) {
    const m = out.get(l.periodMonth) ?? new Map<string, FinanceCommissionHotel>();
    const a = per(l.hotelId, l.periodMonth);
    m.set(l.hotelId, a ?? { hotelId: l.hotelId, commissionStart: null, attribution: null });
    out.set(l.periodMonth, m);
  }
  return out;
};
const run = (
  over: Partial<ClosingInput> & { lines: ClosingLine[]; per: Parameters<typeof answersOf>[0] },
) =>
  computeClosing({
    month: '2027-07',
    mode: 'TEST',
    booked: [],
    latest: () => null,
    answers: answersOf(over.per, over.lines),
    ...over,
  });
const booked = (
  l: ClosingLine,
  sp: typeof A,
  period: string,
  over: Partial<BookedItem> = {},
): BookedItem => ({
  statementPeriod: period,
  salespersonId: sp.salespersonId,
  salespersonName: sp.displayName,
  kind: 'REGULAR',
  cause: 'REGULAR',
  invoiceId: l.invoiceId,
  lineNo: l.lineNo,
  base: cents(l.amount),
  rate: '20.00',
  k: 2,
  amount: commission(cents(l.amount), '20.00'),
  attributionRevision: 1,
  bindingId: 'b1',
  termsVersion: 1,
  ...over,
});
const latestOf =
  (rows: Record<string, LatestStatement>) =>
  (sp: string): LatestStatement | null =>
    rows[sp] ?? null;

describe('commission closing — the calculation (doc 069 §5)', () => {
  it('money: exact, per line half-up to 0.01', () => {
    expect(commission(cents('4820.00'), '20.00')).toBe(cents('964.00'));
    expect(commission(cents('0.05'), '10.00')).toBe(1);
    expect(commission(cents('0.04'), '10.00')).toBe(0);
    expect(() => cents('1.005')).toThrow();
    expect(money(-96400)).toBe('-964.00');
    expect(closedBy('2027-07', '2027-07-31')).toBe(false);
    expect(closedBy('2027-07', '2027-08-01')).toBe(true);
    expect(closedBy('2027-12', '2028-01-01')).toBe(true);
  });

  it('the billed period decides; another month is not in July', () => {
    const lines = [line({}), line({ periodMonth: '2027-08' })];
    const r = run({ lines, per: (h) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00')) });
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0]!.items.map((i) => i.serviceMonth)).toEqual(['2027-07']);
    expect(r.statements[0]!.total).toBe(cents('964.00'));
  });

  it('a summary invoice with two hotels → two salespeople', () => {
    const lines = [
      line({ invoiceId: 'sum', lineNo: 1, hotelId: 'h-1' }),
      line({
        invoiceId: 'sum',
        lineNo: 2,
        hotelId: 'h-2',
        hotelCode: 'HT-000002',
        amount: '3000.00',
      }),
    ];
    const r = run({
      lines,
      per: (h) =>
        h === 'h-1'
          ? hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00'))
          : hotelAnswer(h, B, plan('b2', '10.00', 36, '3.00')),
    });
    expect(
      Object.fromEntries(r.statements.map((s) => [s.salespersonName, money(s.total)])),
    ).toEqual({
      'Alena Fiktivní': '964.00',
      'Bohdan Smyšlený': '300.00',
    });
  });

  it('the rate boundary k = 24 / 25', () => {
    const lines = [
      line({ hotelId: 'h-24', hotelCode: 'HT-24' }),
      line({ hotelId: 'h-25', hotelCode: 'HT-25' }),
    ];
    const [s] = run({
      lines,
      per: (h) =>
        hotelAnswer(h, A, plan('b', '20.00', 24, '5.00'), h === 'h-24' ? '2025-08' : '2025-07'),
    }).statements;
    expect(s!.items.map((i) => [i.hotelCode, i.k, i.rate])).toEqual([
      ['HT-24', 24, '20.00'],
      ['HT-25', 25, '5.00'],
    ]);
  });

  it('no attribution, before the start, Firemní hotel, missing terms, another currency', () => {
    const lines = [
      line({ hotelId: 'h-none', hotelCode: 'HT-NONE' }),
      line({ hotelId: 'h-early', hotelCode: 'HT-EARLY' }),
      line({ hotelId: 'h-house', hotelCode: 'HT-HOUSE' }),
      line({ hotelId: 'h-noterms', hotelCode: 'HT-NOTERMS' }),
      line({ hotelId: 'h-eur', hotelCode: 'HT-EUR', currency: 'EUR' }),
      line({ hotelId: 'h-ok', hotelCode: 'HT-OK' }),
    ];
    const r = run({
      lines,
      per: (h) =>
        ({
          'h-none': null,
          'h-early': { hotelId: h, commissionStart: '2027-09', attribution: null },
          'h-house': hotelAnswer(h, null, null),
          'h-noterms': hotelAnswer(h, A, null),
          'h-eur': hotelAnswer(h, B, plan('b2', '10.00', 36, '3.00')),
          'h-ok': hotelAnswer(h, B, plan('b2', '10.00', 36, '3.00')),
        })[h] ?? null,
    });
    expect(r.unresolved.map((u) => [u.reason, u.hotelCode])).toEqual(
      expect.arrayContaining([
        ['UNASSIGNED', 'HT-NONE'],
        ['BEFORE_COMMISSION_START', 'HT-EARLY'],
      ]),
    );
    expect(r.unresolved).toHaveLength(2);
    const a = r.statements.find((s) => s.salespersonId === A.salespersonId)!;
    expect(a.flags.map((f) => f.code)).toEqual(['TERMS_MISSING']);
    const bs = r.statements.filter((s) => s.salespersonId === B.salespersonId);
    expect(bs.map((s) => [s.currency, s.flags.map((f) => f.code), s.items.length])).toEqual(
      expect.arrayContaining([
        ['EUR', ['CURRENCY_UNSUPPORTED'], 0],
        ['CZK', [], 1],
      ]),
    );
    expect(r.statements.some((s) => s.items.some((i) => i.hotelCode === 'HT-HOUSE'))).toBe(false);
  });

  it('cancelled before approval: excluded; after: one correction in the nearest admissible month', () => {
    expect(
      run({
        lines: [line({ cancelled: true })],
        per: (h) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00')),
      }).statements,
    ).toEqual([]);
    const july = line({ invoiceId: 'inv-j', cancelled: true });
    const sep = line({ invoiceId: 'inv-s', periodMonth: '2027-09', amount: '6000.00' });
    const per = (h: string) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00'));
    const common = {
      lines: [july, sep],
      per,
      booked: [booked(july, A, '2027-07', { k: 2 })],
      latest: latestOf({
        [A.salespersonId]: { id: 'st-jul', periodMonth: '2027-07', carriedForward: 0 },
      }),
    };
    expect(run({ ...common, month: '2027-06' }).statements).toEqual([]); // never an earlier month
    const aug = run({ ...common, month: '2027-08' }).statements[0]!;
    expect(aug.items.map((i) => [i.kind, i.cause, i.serviceMonth, i.amount])).toEqual([
      ['CORRECTION', 'CANCELLED', '2027-07', -cents('964.00')],
    ]);
    // §5c: −964.00 is not an amount to invoice; it is carried.
    expect([aug.total, aug.amountToInvoice, aug.carriedForward]).toEqual([
      -cents('964.00'),
      0,
      -cents('964.00'),
    ]);
    // September shows the open August and is blocked for Alena only.
    const sepSt = run({ ...common, month: '2027-09' }).statements[0]!;
    expect(sepSt.flags.map((f) => [f.code, f.dueMonth])).toEqual([
      ['EARLIER_PERIOD_OPEN', '2027-08'],
    ]);
    expect(sepSt.items.map((i) => i.invoiceId)).toEqual(['inv-s']);
  });

  it('a negative balance is netted in the next statement', () => {
    const sep = line({ invoiceId: 'inv-s', periodMonth: '2027-09', amount: '6000.00' });
    const [s] = run({
      month: '2027-09',
      lines: [sep],
      per: (h) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00')),
      latest: latestOf({
        [A.salespersonId]: {
          id: 'st-aug',
          periodMonth: '2027-08',
          carriedForward: -cents('964.00'),
        },
      }),
    }).statements;
    expect([s!.opening, s!.total, s!.closing, s!.amountToInvoice, s!.carriedForward]).toEqual([
      -cents('964.00'),
      cents('1200.00'),
      cents('236.00'),
      cents('236.00'),
      0,
    ]);
  });

  it('a late invoice: its own month without any statement; after the latest statement otherwise', () => {
    const late = line({ invoiceId: 'inv-late', hotelId: 'h-2' });
    const per = (h: string) => hotelAnswer(h, B, plan('b2', '10.00', 36, '3.00'));
    // No statement of Bohdan: due July — shown in August as open, approvable in July.
    const aug = run({ month: '2027-08', lines: [late], per }).statements[0]!;
    expect(aug.flags.map((f) => [f.code, f.dueMonth, f.invoiceNumber])).toEqual([
      ['EARLIER_PERIOD_OPEN', '2027-07', late.invoiceNumber],
    ]);
    expect(
      run({ month: '2027-07', lines: [late], per }).statements[0]!.items.map((i) => i.invoiceId),
    ).toEqual(['inv-late']);
    // Bohdan already has September: the July line is due in October, original month and rate.
    const latest = latestOf({
      [B.salespersonId]: { id: 'st-sep', periodMonth: '2027-09', carriedForward: 0 },
    });
    const oct = run({ month: '2027-10', lines: [late], per, latest }).statements[0]!;
    expect(oct.items.map((i) => [i.invoiceId, i.serviceMonth, i.rate, i.k])).toEqual([
      ['inv-late', '2027-07', '10.00', 2],
    ]);
    expect(run({ month: '2027-07', lines: [late], per, latest }).statements).toEqual([]);
  });

  it('an attribution corrected after approval: reversal for the old, a new item for the new recipient', () => {
    const july = line({});
    const r = run({
      month: '2027-08',
      lines: [july],
      per: () => hotelAnswer('h-1', B, plan('b2', '10.00', 36, '3.00'), '2027-06', 2),
      booked: [booked(july, A, '2027-07')],
      latest: latestOf({
        [A.salespersonId]: { id: 'st-a', periodMonth: '2027-07', carriedForward: 0 },
      }),
    });
    const by = Object.fromEntries(
      r.statements.map((s) => [s.salespersonName, s.items.map((i) => [i.cause, i.rate, i.amount])]),
    );
    expect(by).toEqual({
      'Alena Fiktivní': [['REATTRIBUTED:2', '20.00', -cents('964.00')]],
      'Bohdan Smyšlený': [['REATTRIBUTED:2', '10.00', cents('482.00')]],
    });
  });

  it('settled once: a booked line whose sources did not change yields nothing', () => {
    const july = line({});
    const r = run({
      month: '2027-08',
      lines: [july],
      per: (h) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00')),
      booked: [booked(july, A, '2027-07')],
      latest: latestOf({
        [A.salespersonId]: { id: 'st-a', periodMonth: '2027-07', carriedForward: 0 },
      }),
    });
    expect(r.statements).toEqual([]);
  });

  it('TEST lines never enter a LIVE statement (O1: no live kind exists)', () => {
    const r = run({
      mode: 'LIVE',
      lines: [line({})],
      per: (h) => hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00')),
    });
    expect(r).toEqual({ statements: [], unresolved: [] });
  });

  it("each salesperson's fingerprint covers only their own sources", () => {
    const lines = [line({ hotelId: 'h-1' }), line({ hotelId: 'h-2', hotelCode: 'HT-2' })];
    const per = (h: string, rate = '10.00') =>
      h === 'h-1'
        ? hotelAnswer(h, A, plan('b1', '20.00', 24, '5.00'))
        : hotelAnswer(h, B, plan('b2', rate, 36, '3.00'));
    const one = run({ lines, per: (h) => per(h) }).statements;
    const two = run({ lines, per: (h) => per(h, '12.00') }).statements;
    const fp = (s: typeof one, sp: string) => s.find((x) => x.salespersonId === sp)!.fingerprint;
    expect(fp(one, A.salespersonId)).toBe(fp(two, A.salespersonId));
    expect(fp(one, B.salespersonId)).not.toBe(fp(two, B.salespersonId));
  });
});
