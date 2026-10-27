import { describe, expect, it } from 'vitest';
import {
  fileSize,
  financeAmount,
  financeDate,
  financeMonth,
  sumAmounts,
  timesRooms,
} from './finance-format';

describe('finance formatting', () => {
  it('shows dates and amounts the Czech way without changing the value', () => {
    expect(financeDate('2026-10-01')).toBe('1. 10. 2026');
    expect(financeDate(null)).toBe('—');
    expect(financeAmount('25000.00', 'CZK')).toBe('25 000,00 CZK');
    expect(financeAmount('-1234567.5', 'EUR')).toBe('−1 234 567,50 EUR');
    expect(financeAmount('7', 'CZK')).toBe('7,00 CZK');
    expect(financeAmount(null, null)).toBe('—');
    expect(financeMonth('2026-09')).toBe('9/2026');
    expect(financeMonth(null)).toBe('—');
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2 kB');
    expect(fileSize(3 * 1024 * 1024)).toBe('3,0 MB');
  });

  it('adds and multiplies amounts exactly (never a float)', () => {
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.30');
    expect(sumAmounts(['3000.00', '6172.80'])).toBe('9172.80');
    expect(sumAmounts([])).toBe('0.00');
    expect(sumAmounts(['-1.05', '1'])).toBe('-0.05');
    expect(timesRooms(5, '1234.56')).toBe('6172.80');
    expect(timesRooms(12, '350.5')).toBe('4206.00');
    expect(timesRooms(3, '0.01')).toBe('0.03');
  });
});
