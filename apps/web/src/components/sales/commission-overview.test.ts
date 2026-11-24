import type { CommissionStatement, CommissionStatementPreview } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { monthIsEmpty, overviewRows, stateCounts } from './commission-overview';

const A = { id: '00000000-0000-4000-8000-00000000000a', name: 'Alena' };
const B = { id: '00000000-0000-4000-8000-00000000000b', name: 'Bohdan' };
const C = { id: '00000000-0000-4000-8000-00000000000c', name: 'Cyril' };

const item = (hotelCode: string, amount = '100.00') => ({
  kind: 'REGULAR' as const,
  cause: 'REGULAR',
  invoiceNumber: `TEST-${hotelCode}`,
  lineNo: 1,
  hotelCode,
  serviceMonth: '2026-10',
  base: '1000.00',
  k: 1,
  rate: '10.00',
  amount,
  attributionRevision: 1,
  termsVersion: 1,
});

const preview = (
  salesperson: { id: string; name: string },
  over: Partial<CommissionStatementPreview> = {},
): CommissionStatementPreview => ({
  salesperson,
  currency: 'CZK',
  previousPeriod: null,
  openingBalance: '0.00',
  total: '100.00',
  closingBalance: '100.00',
  amountToInvoice: '100.00',
  carriedForward: '0.00',
  items: [item('H-1')],
  flags: [],
  fingerprint: 'f'.repeat(64),
  ...over,
});

const approved = (
  salesperson: { id: string; name: string },
  over: Partial<CommissionStatement> = {},
): CommissionStatement => ({
  id: '10000000-0000-4000-8000-000000000001',
  month: '2026-10',
  mode: 'TEST',
  salesperson,
  currency: 'CZK',
  previousPeriod: null,
  openingBalance: '0.00',
  total: '1679.98',
  closingBalance: '1679.98',
  amountToInvoice: '1679.98',
  carriedForward: '0.00',
  items: [item('H-1', '839.99'), item('H-2', '839.99')],
  fingerprint: 'f'.repeat(64),
  sourcesReadAt: '2026-11-02T08:00:00Z',
  approvedAt: '2026-11-02T08:00:00Z',
  approvedByName: 'Admin',
  salespersonInvoice: null,
  ...over,
});

const invoice = {
  invoiceNumber: 'TEST-PROV-2026-10',
  issuedOn: '2026-11-03',
  receivedOn: '2026-11-03',
  base: '1679.98',
  currency: 'CZK',
  payoutOn: '2026-11-15',
  recordedAt: '2026-11-03T09:00:00Z',
  recordedByName: 'Admin',
};

describe('overviewRows', () => {
  it('the DEV 10/2026 case: an approved statement with an empty preview is one row, not "nothing"', () => {
    const rows = overviewRows(
      { statements: [] },
      { statements: [approved(A, { salespersonInvoice: invoice })] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'INVOICE_RECEIVED', hotels: 2, conflict: false });
    expect(monthIsEmpty({ ok: true, statements: [] }, { ok: true, statements: rows })).toBe(false);
  });

  it('distinguishes every state and orders what needs action first', () => {
    const D = { id: '00000000-0000-4000-8000-00000000000d', name: 'Dana' };
    const E = { id: '00000000-0000-4000-8000-00000000000e', name: 'Eva' };
    const rows = overviewRows(
      {
        statements: [
          preview(A),
          preview(B, {
            flags: [
              {
                code: 'TERMS_MISSING',
                invoiceNumber: 'TEST-H-9',
                hotelCode: 'H-9',
                serviceMonth: '2026-10',
                dueMonth: null,
              },
            ],
          }),
        ],
      },
      {
        statements: [
          approved(C),
          approved(D, { salespersonInvoice: invoice }),
          approved(E, { amountToInvoice: '0.00', carriedForward: '-50.00' }),
        ],
      },
    );
    expect(rows.map((r) => [r.salesperson.name, r.state])).toEqual([
      ['Bohdan', 'BLOCKED'],
      ['Alena', 'AWAITING_APPROVAL'],
      ['Cyril', 'TO_INVOICE'],
      ['Dana', 'INVOICE_RECEIVED'],
      ['Eva', 'NOTHING_TO_INVOICE'],
    ]);
    expect(stateCounts(rows)).toEqual({
      BLOCKED: 1,
      AWAITING_APPROVAL: 1,
      TO_INVOICE: 1,
      INVOICE_RECEIVED: 1,
      NOTHING_TO_INVOICE: 1,
    });
  });

  it('counts a flagged hotel and keeps currencies apart (never summed, non-CZK not approvable)', () => {
    const rows = overviewRows(
      {
        statements: [
          preview(A),
          preview(A, { currency: 'EUR', items: [item('H-7')], fingerprint: 'e'.repeat(64) }),
        ],
      },
      null,
    );
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      [`${A.id}|EUR`, 'BLOCKED'],
      [`${A.id}|CZK`, 'AWAITING_APPROVAL'],
    ]);
  });

  it('a preview for an already approved key is shown as a conflict, never merged away', () => {
    const rows = overviewRows({ statements: [preview(A)] }, { statements: [approved(A)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'BLOCKED', conflict: true });
    expect(rows[0]!.approved).not.toBeNull();
    expect(rows[0]!.preview).not.toBeNull();
  });

  it('one failed source keeps the other visible', () => {
    expect(overviewRows(null, { statements: [approved(A)] })).toHaveLength(1);
    expect(overviewRows({ statements: [preview(B)] }, null)).toHaveLength(1);
  });

  it('20+ hotels stay one row with the distinct hotel count', () => {
    const items = Array.from({ length: 24 }, (_, i) => item(`H-${i + 1}`));
    const [row] = overviewRows({ statements: [preview(A, { items })] }, null);
    expect(row!.hotels).toBe(24);
  });
});

describe('monthIsEmpty', () => {
  it('only when both sources answered with nothing', () => {
    expect(monthIsEmpty({ ok: true, statements: [] }, { ok: true, statements: [] })).toBe(true);
    expect(monthIsEmpty({ ok: false }, { ok: true, statements: [] })).toBe(false);
    expect(monthIsEmpty({ ok: true, statements: [] }, { ok: false })).toBe(false);
    expect(monthIsEmpty({ ok: true, statements: [] }, { ok: true, statements: [{}] })).toBe(false);
  });
});
