import { describe, expect, it } from 'vitest';
import { bankListState } from './bank-state';

describe('Bankovní pohyby: one clear state below the connection (UI-08)', () => {
  it('not connected and nothing read: only "not connected" — no list asking to read from the bank', () => {
    expect(bankListState({ connected: false, total: 0, filtered: false })).toBe('NOT_CONNECTED');
  });
  it('connected without movements; a filter that matches nothing; movements to list', () => {
    expect(bankListState({ connected: true, total: 0, filtered: false })).toBe('NO_TRANSACTIONS');
    expect(bankListState({ connected: true, total: 0, filtered: true })).toBe('FILTERED_EMPTY');
    expect(bankListState({ connected: true, total: 3, filtered: false })).toBe('LIST');
  });
  it('movements read before the connection was removed are still listed (never hidden)', () => {
    expect(bankListState({ connected: false, total: 3, filtered: false })).toBe('LIST');
    expect(bankListState({ connected: false, total: 0, filtered: true })).toBe('FILTERED_EMPTY');
  });
});
