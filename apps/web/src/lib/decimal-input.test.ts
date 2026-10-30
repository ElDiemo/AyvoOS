import { describe, expect, it } from 'vitest';
import { parseDecimalInput } from './decimal-input';

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
    ])
      expect(parseDecimalInput(input!)).toBe(out);
  });
  it('refuses what is unclear, never rounds', () => {
    for (const input of ['', 'abc', '1,5,0', '1.500,50', '1,234', '-5', '1e3', ',5', '5,'])
      expect(parseDecimalInput(input), input).toBeNull();
  });
});
