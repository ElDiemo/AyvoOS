import { describe, expect, it } from 'vitest';
import { addDays, daysInMonth, nextPlannedDay, plannedDays } from './supply-calendar.js';

const open = { validFrom: '2020-01-01', validTo: null };

describe('supply plan calendar (doc 032)', () => {
  it('two rules on the same day make one day; the same product is one line with the sum', () => {
    const { days } = plannedDays(
      [
        { productCode: 'MYDLO', crates: 2, days: [1, 11, 21] },
        { productCode: 'GEL', crates: 1, days: [5, 21] },
        { productCode: 'MYDLO', crates: 1, days: [21] },
      ],
      { from: '2026-11-01', to: '2026-11-30' },
      open,
    );
    expect(days).toEqual([
      { shipDate: '2026-11-01', lines: [{ productCode: 'MYDLO', crates: 2 }] },
      { shipDate: '2026-11-05', lines: [{ productCode: 'GEL', crates: 1 }] },
      { shipDate: '2026-11-11', lines: [{ productCode: 'MYDLO', crates: 2 }] },
      {
        shipDate: '2026-11-21',
        lines: [
          { productCode: 'MYDLO', crates: 3 },
          { productCode: 'GEL', crates: 1 },
        ],
      },
    ]);
  });

  it('a day a month lacks is skipped that month — never moved — and reported', () => {
    const r = plannedDays(
      [{ productCode: 'MYDLO', crates: 1, days: [30, 31] }],
      { from: '2026-11-01', to: '2026-12-31' },
      open,
    );
    expect(r.days.map((d) => d.shipDate)).toEqual(['2026-11-30', '2026-12-30', '2026-12-31']);
    expect(r.skipped).toEqual([{ productCode: 'MYDLO', day: 31, month: '2026-11' }]);
  });

  it('February: 29–31 skipped in a common year; 29 planned in a leap year', () => {
    const rules = [{ productCode: 'GEL', crates: 1, days: [28, 29, 30, 31] }];
    const common = plannedDays(rules, { from: '2027-02-01', to: '2027-02-28' }, open);
    expect(common.days.map((d) => d.shipDate)).toEqual(['2027-02-28']);
    expect(common.skipped.map((s) => s.day)).toEqual([29, 30, 31]);
    const leap = plannedDays(rules, { from: '2028-02-01', to: '2028-02-29' }, open);
    expect(leap.days.map((d) => d.shipDate)).toEqual(['2028-02-28', '2028-02-29']);
    expect(leap.skipped.map((s) => s.day)).toEqual([30, 31]);
    expect([daysInMonth(2027, 2), daysInMonth(2028, 2), daysInMonth(2100, 2)]).toEqual([
      28, 29, 28,
    ]);
  });

  it('only inside the validity and the window', () => {
    const r = plannedDays(
      [{ productCode: 'MYDLO', crates: 1, days: [1, 15] }],
      { from: '2026-10-20', to: '2026-12-31' },
      { validFrom: '2026-11-10', validTo: '2026-12-01' },
    );
    expect(r.days.map((d) => d.shipDate)).toEqual(['2026-11-15', '2026-12-01']);
  });

  it('calendar days across month and year ends (no clock, no time zone)', () => {
    expect(addDays('2026-12-25', 13)).toBe('2027-01-07');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26'); // EU daylight saving ends that night
    expect(nextPlannedDay([{ productCode: 'X', crates: 1, days: [31] }], '2026-11-01', open)).toBe(
      '2026-12-31',
    );
  });
});
