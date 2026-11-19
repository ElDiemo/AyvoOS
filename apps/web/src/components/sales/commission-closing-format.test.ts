import type { CommissionStatementPreview } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import {
  causeLabel,
  closableFrom,
  deviations,
  earliestPayout,
  hotelCount,
  invoiceBase,
  isMonth,
  nextMonth,
  pragueMonth,
  previousMonth,
  refusalText,
} from './commission-closing-format';

const item = (over: Partial<CommissionStatementPreview['items'][number]> = {}) => ({
  kind: 'REGULAR' as const,
  cause: 'REGULAR',
  invoiceNumber: 'T0001-00001',
  lineNo: 1,
  hotelCode: 'H-1',
  serviceMonth: '2026-10',
  base: '1000.00',
  k: 1,
  rate: '20.00',
  amount: '200.00',
  attributionRevision: 1,
  termsVersion: 1,
  ...over,
});
const statement = (over: Partial<CommissionStatementPreview> = {}): CommissionStatementPreview => ({
  salesperson: { id: '00000000-0000-4000-8000-000000000001', name: 'Alena' },
  currency: 'CZK',
  previousPeriod: null,
  openingBalance: '0.00',
  total: '200.00',
  closingBalance: '200.00',
  amountToInvoice: '200.00',
  carriedForward: '0.00',
  items: [item()],
  flags: [],
  fingerprint: 'a'.repeat(64),
  ...over,
});

describe('commission closing display (doc 069, PR 2e)', () => {
  it('months: Prague month, neighbours over the year, the closing and payout days', () => {
    // 23:30 UTC on 31 October is already November in Prague (winter time UTC+1).
    expect(pragueMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(previousMonth('2027-01')).toBe('2026-12');
    expect(closableFrom('2026-10')).toBe('1. 11. 2026');
    expect(earliestPayout('2026-12')).toBe('15. 1. 2027');
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-09')).toBe(true);
  });

  it('causes and hotels as Finance lists them', () => {
    expect(causeLabel({ cause: 'REGULAR' })).toBe('Provize');
    expect(causeLabel({ cause: 'CANCELLED' })).toBe('Oprava – storno faktury');
    expect(causeLabel({ cause: 'REATTRIBUTED:2' })).toBe('Oprava – změna obchodníka (revize 2)');
    expect(causeLabel({ cause: 'SOMETHING_NEW' })).toBe('SOMETHING_NEW');
    expect(hotelCount([item(), item({ lineNo: 2 }), item({ hotelCode: 'H-2' })])).toBe(2);
  });

  it('deviations: corrections, flags block, a carried negative balance', () => {
    expect(deviations(statement())).toEqual({
      corrections: [],
      flags: [],
      carriedIn: null,
      blocked: false,
    });
    const storno = item({ kind: 'CORRECTION', cause: 'CANCELLED', amount: '-200.00' });
    const d = deviations(
      statement({
        openingBalance: '-100.00',
        items: [storno],
        flags: [
          {
            code: 'TERMS_MISSING',
            invoiceNumber: 'T1',
            hotelCode: 'H-3',
            serviceMonth: '2026-10',
            dueMonth: null,
          },
        ],
      }),
    );
    expect(d.corrections).toEqual([storno]);
    expect(d.carriedIn).toBe('-100.00');
    expect(d.blocked).toBe(true);
  });

  it('the invoice base is normalised, never rounded', () => {
    expect(invoiceBase('1 234,5')).toBe('1234.50');
    expect(invoiceBase('420')).toBe('420.00');
    expect(invoiceBase('0420.00')).toBe('420.00');
    expect(invoiceBase('420.005')).toBeNull();
    expect(invoiceBase('-5')).toBeNull();
    expect(invoiceBase('')).toBeNull();
  });

  it('a refusal code maps to its text, anything else to the fallback', () => {
    const table = { STATEMENT_STALE: 'změna' };
    expect(refusalText(table, 'STATEMENT_STALE', 'x')).toBe('změna');
    expect(refusalText(table, 'OTHER', 'x')).toBe('x');
    expect(refusalText(table, null, 'x')).toBe('x');
  });
});
