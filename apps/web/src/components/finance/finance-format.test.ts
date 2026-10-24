import { describe, expect, it } from 'vitest';
import { fileSize, financeAmount, financeDate } from './finance-format';

describe('finance formatting', () => {
  it('shows dates and amounts the Czech way without changing the value', () => {
    expect(financeDate('2026-10-01')).toBe('1. 10. 2026');
    expect(financeDate(null)).toBe('—');
    expect(financeAmount('25000.00', 'CZK')).toBe('25 000,00 CZK');
    expect(financeAmount('-1234567.5', 'EUR')).toBe('−1 234 567,50 EUR');
    expect(financeAmount('7', 'CZK')).toBe('7,00 CZK');
    expect(financeAmount(null, null)).toBe('—');
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2 kB');
    expect(fileSize(3 * 1024 * 1024)).toBe('3,0 MB');
  });
});
