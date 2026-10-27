/**
 * What Finance → Bankovní pohyby shows below the connection (UI-08) — one clear state, never an
 * action the user cannot take and never invented movements:
 * - NOT_CONNECTED: no bank connection and nothing read before → only "not connected" and who
 *   connects it; no filters, no empty list asking to read;
 * - NO_TRANSACTIONS: connected, nothing read yet (or nothing in the bank's window);
 * - FILTERED_EMPTY: transactions exist, the filter matches none;
 * - LIST: transactions to show (also when the connection was removed later — they stay).
 * A failed read is shown in the connection card (the last run's error), not here.
 */
export type BankListState = 'NOT_CONNECTED' | 'NO_TRANSACTIONS' | 'FILTERED_EMPTY' | 'LIST';

export function bankListState(input: {
  connected: boolean;
  total: number;
  filtered: boolean;
}): BankListState {
  if (input.total > 0) return 'LIST';
  if (input.filtered) return 'FILTERED_EMPTY';
  return input.connected ? 'NO_TRANSACTIONS' : 'NOT_CONNECTED';
}
