import type {
  CommissionPreview,
  CommissionStatement,
  CommissionStatementList,
  CommissionStatementPreview,
} from '@ayvo/types';
import { hotelCount } from './commission-closing-format';

/**
 * The admin's monthly commission overview (doc 069 §5–§6): ONE row per salesperson and currency
 * with the current real state, merged from the two existing Finance reads — the preview (what is
 * not approved yet) and the approved statements — by the stable salesperson id + currency. Only
 * presentation: every amount, flag and rule stays the server's. Currencies are never summed.
 */

export const ROW_STATES = [
  'BLOCKED',
  'AWAITING_APPROVAL',
  'TO_INVOICE',
  'INVOICE_RECEIVED',
  'NOTHING_TO_INVOICE',
] as const;
export type RowState = (typeof ROW_STATES)[number];

export type OverviewRow = {
  key: string;
  salesperson: { id: string; name: string };
  currency: string;
  state: RowState;
  hotels: number;
  /** The not-approved preview of the month (states BLOCKED / AWAITING_APPROVAL). */
  preview: CommissionStatementPreview | null;
  /** The approved statement of the month (states TO_INVOICE / INVOICE_RECEIVED / NOTHING_…). */
  approved: CommissionStatement | null;
  /**
   * Both sources answered for the same key. Finance never previews an approved salesperson of
   * the month (the next due month starts after it), so this is shown as a conflict, not merged.
   */
  conflict: boolean;
};

/** Only CZK is approvable today (approveCommissionStatementSchema.currency). */
export const APPROVABLE_CURRENCY = 'CZK';

export function previewState(s: CommissionStatementPreview): RowState {
  return s.flags.length > 0 || s.currency !== APPROVABLE_CURRENCY ? 'BLOCKED' : 'AWAITING_APPROVAL';
}

export function approvedState(s: CommissionStatement): RowState {
  if (s.salespersonInvoice) return 'INVOICE_RECEIVED';
  return s.amountToInvoice === '0.00' ? 'NOTHING_TO_INVOICE' : 'TO_INVOICE';
}

const order = (s: RowState) => ROW_STATES.indexOf(s);

export function overviewRows(
  preview: Pick<CommissionPreview, 'statements'> | null,
  approved: Pick<CommissionStatementList, 'statements'> | null,
): OverviewRow[] {
  const rows = new Map<string, OverviewRow>();
  const keyOf = (s: { salesperson: { id: string }; currency: string }) =>
    `${s.salesperson.id}|${s.currency}`;
  for (const s of approved?.statements ?? []) {
    rows.set(keyOf(s), {
      key: keyOf(s),
      salesperson: s.salesperson,
      currency: s.currency,
      state: approvedState(s),
      hotels: hotelCount(s.items),
      preview: null,
      approved: s,
      conflict: false,
    });
  }
  for (const s of preview?.statements ?? []) {
    const existing = rows.get(keyOf(s));
    if (existing) {
      // Never hide the approved result nor the open preview: the row needs a look.
      existing.preview = s;
      existing.conflict = true;
      existing.state = 'BLOCKED';
      continue;
    }
    rows.set(keyOf(s), {
      key: keyOf(s),
      salesperson: s.salesperson,
      currency: s.currency,
      state: previewState(s),
      hotels: hotelCount([...s.items, ...s.flags]),
      preview: s,
      approved: null,
      conflict: false,
    });
  }
  return [...rows.values()].sort(
    (a, b) =>
      order(a.state) - order(b.state) ||
      a.salesperson.name.localeCompare(b.salesperson.name, 'cs') ||
      a.salesperson.id.localeCompare(b.salesperson.id) ||
      a.currency.localeCompare(b.currency),
  );
}

/** How many rows per state (for the short summary above the list). */
export function stateCounts(rows: readonly OverviewRow[]): Partial<Record<RowState, number>> {
  const out: Partial<Record<RowState, number>> = {};
  for (const r of rows) out[r.state] = (out[r.state] ?? 0) + 1;
  return out;
}

/**
 * Whether the page may say "nothing to close this month": only when BOTH sources answered and
 * both are empty. An outage of one source is never an empty month, and approved results with an
 * empty preview are results, not "nothing".
 */
export function monthIsEmpty(
  preview: { ok: boolean; statements?: readonly unknown[] },
  approved: { ok: boolean; statements?: readonly unknown[] },
): boolean {
  return (
    preview.ok &&
    approved.ok &&
    (preview.statements?.length ?? 0) === 0 &&
    (approved.statements?.length ?? 0) === 0
  );
}
