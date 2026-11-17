import { describe, expect, it } from 'vitest';
import { parseCommissionRate } from './commissions.js';

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
