import { describe, expect, it } from 'vitest';
import { formatDecimalInput, parseDecimalInput } from './decimal-input';

describe('parseDecimalInput', () => {
  it('reads Czech and plain notation exactly', () => {
    for (const [input, out] of [
      ['1 500,50', '1500.50'],
      ['1 500,5', '1500.50'],
      ['1500.5', '1500.50'],
      ['0,1', '0.10'],
      ['007', '7.00'],
      ['0', '0.00'],
      ['99999999999999999.99', '99999999999999999.99'],
      ['1 500 000,5', '1500000.50'],
      ['1\u00a0500,50', '1500.50'],
      ['  1 500  ', '1500.00'],
    ])
      expect(parseDecimalInput(input!)).toBe(out);
  });
  it('refuses what is unclear, never rounds', () => {
    for (const input of ['', 'abc', '1,5,0', '1.500,50', '1,234', '-5', '1e3', ',5', '5,'])
      expect(parseDecimalInput(input), input).toBeNull();
  });
  it('spaces only between groups of thousands: anything else is not guessed', () => {
    for (const input of [
      '1 2',
      '12 34',
      '1 50',
      '1 5000',
      '1500 000',
      '0 500',
      '1 500 00',
      '1,5 0',
    ])
      expect(parseDecimalInput(input), input).toBeNull();
  });
});

describe('formatDecimalInput', () => {
  it('shows a stored amount as typed, and reads back to the same value (review SMOKE-3)', () => {
    for (const [stored, shown] of [
      ['1000.50', '1 000,50'],
      ['333.33', '333,33'],
      ['1500000.05', '1 500 000,05'],
      ['7', '7'],
    ] as const) {
      expect(formatDecimalInput(stored)).toBe(shown);
      expect(parseDecimalInput(shown)).toBe(parseDecimalInput(stored));
    }
  });
});
