import { describe, expect, it } from 'vitest';
import { dueLabel, salesNowLocal } from './sales-format';

describe('sales dates (doc 034 §6)', () => {
  it('labels due dates against the server day, never the device clock', () => {
    expect(dueLabel('2026-10-20', '2026-10-21')).toMatchObject({ tone: 'overdue' });
    expect(dueLabel('2026-10-21', '2026-10-21')).toEqual({ text: 'dnes', tone: 'today' });
    expect(dueLabel('2026-10-22', '2026-10-21')).toEqual({ text: 'zítra', tone: 'later' });
    expect(dueLabel('2026-11-01', '2026-10-31')).toEqual({ text: 'zítra', tone: 'later' });
  });
  it('shows "now" in Europe/Prague whatever the device zone is', () => {
    // 22:30 UTC on 21 October (summer time) is 00:30 on 22 October in Prague.
    expect(salesNowLocal(new Date('2026-10-21T22:30:00Z'))).toBe('2026-10-22T00:30');
    // Winter time: UTC+1.
    expect(salesNowLocal(new Date('2026-12-01T08:05:00Z'))).toBe('2026-12-01T09:05');
  });
});
