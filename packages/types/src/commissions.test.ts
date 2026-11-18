import { describe, expect, it } from 'vitest';
import {
  attributionTimeline,
  commissionMonthNumber,
  commissionPhase,
  parseCommissionRate,
  previousMonth,
} from './commissions.js';

describe('parseCommissionRate (doc 068 §3.1: 0–100, at most 2 decimals, never rounded)', () => {
  it.each([
    ['20', '20.00'],
    ['5,5', '5.50'],
    ['0', '0.00'],
    ['0.00', '0.00'],
    ['100', '100.00'],
    ['100.00', '100.00'],
    [' 12.34 ', '12.34'],
  ])('accepts %j as %j', (input, out) => expect(parseCommissionRate(input)).toBe(out));

  it.each(['20.005', '100.01', '101', '-1', '', 'abc', '1e2', '20.', '.5', '1000'])(
    'refuses %j',
    (input) => expect(parseCommissionRate(input)).toBeNull(),
  );
});

describe('commission month k and the rate phase (doc 068 C1, §6 boundaries)', () => {
  it('counts calendar months from the commission start (k = 1), across years', () => {
    expect(commissionMonthNumber('2027-06', '2027-06')).toBe(1);
    expect(commissionMonthNumber('2027-06', '2027-05')).toBe(0);
    expect(commissionMonthNumber('2027-06', '2028-01')).toBe(8);
    expect(commissionMonthNumber('2027-06', '2029-05')).toBe(24);
    expect(commissionMonthNumber('2027-06', '2029-06')).toBe(25);
  });

  it.each([
    [0, 24, 'BEFORE_START'],
    [1, 24, 'INITIAL'],
    [24, 24, 'INITIAL'],
    [25, 24, 'MAINTENANCE'],
    [36, 36, 'INITIAL'],
    [37, 36, 'MAINTENANCE'],
    [1, 1, 'INITIAL'],
    [2, 1, 'MAINTENANCE'],
  ] as const)('k=%i with N=%i → %s', (k, n, phase) => expect(commissionPhase(k, n)).toBe(phase));
});

describe('attribution timeline (review 1b-R1: a planned later change is never lost)', () => {
  it('A from January, B planned from July, then C from April: C ends in June, B stays', () => {
    const t = attributionTimeline([
      { revision: 1, effectiveFrom: '2029-01' },
      { revision: 2, effectiveFrom: '2029-07' },
      { revision: 3, effectiveFrom: '2029-04' },
    ]);
    expect(t.get(1)).toEqual({ effectiveUntil: '2029-03', supersededBy: null });
    expect(t.get(3)).toEqual({ effectiveUntil: '2029-06', supersededBy: null });
    expect(t.get(2)).toEqual({ effectiveUntil: null, supersededBy: null });
  });

  it('a correction of the same month supersedes the earlier revision', () => {
    const t = attributionTimeline([
      { revision: 1, effectiveFrom: '2029-01' },
      { revision: 2, effectiveFrom: '2029-07' },
      { revision: 3, effectiveFrom: '2029-07' },
    ]);
    expect(t.get(2)).toEqual({ effectiveUntil: null, supersededBy: 3 });
    expect(t.get(3)).toEqual({ effectiveUntil: null, supersededBy: null });
    expect(t.get(1)).toEqual({ effectiveUntil: '2029-06', supersededBy: null });
  });

  it('previousMonth crosses the year', () => {
    expect(previousMonth('2030-01')).toBe('2029-12');
    expect(previousMonth('2029-10')).toBe('2029-09');
  });
});
