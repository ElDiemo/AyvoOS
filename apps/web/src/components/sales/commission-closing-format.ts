import type { CommissionFlag, CommissionItem, CommissionStatementPreview } from '@ayvo/types';
import { commissionsCs } from '@/i18n/cs/commissions';

/**
 * Display helpers of the commission closing (doc 069 §5; PR 2e). They only present what Finance
 * answers: amounts, flags, the payout day and every rule stay on the server.
 */
const t = commissionsCs.closing;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: string | undefined): v is string => !!v && MONTH.test(v);

/** The month ('YYYY-MM') of an instant in Europe/Prague. */
export function pragueMonth(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const get = (k: string) => parts.find((p) => p.type === k)!.value;
  return `${get('year')}-${get('month')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** "2026-10" → "1. 11. 2026": the first day a month may be closed (O12). */
export function closableFrom(month: string): string {
  const [y, m] = nextMonth(month).split('-');
  return `1. ${Number(m)}. ${y}`;
}

/** "2026-10" → "15. 11. 2026": the earliest payout day of a month's statement (doc 069). */
export function earliestPayout(month: string): string {
  const [y, m] = nextMonth(month).split('-');
  return `15. ${Number(m)}. ${y}`;
}

/** REGULAR | CANCELLED | REATTRIBUTED:<rev> → Czech. Unknown causes are shown as they are. */
export function causeLabel(item: Pick<CommissionItem, 'cause'>): string {
  if (item.cause === 'REGULAR') return t.cause.REGULAR;
  if (item.cause === 'CANCELLED') return t.cause.CANCELLED;
  const re = /^REATTRIBUTED:(\d+)$/.exec(item.cause);
  return re ? t.cause.REATTRIBUTED(re[1]!) : item.cause;
}

export function flagLabel(flag: CommissionFlag, month: (m: string) => string): string {
  if (flag.code === 'EARLIER_PERIOD_OPEN')
    return t.flag.EARLIER_PERIOD_OPEN(flag.dueMonth ? month(flag.dueMonth) : '—');
  return t.flag[flag.code];
}

/** The distinct hotels of the statement's items and flags (what the preview itself lists). */
export function hotelCount(items: readonly Pick<CommissionItem, 'hotelCode'>[]): number {
  return new Set(items.map((i) => i.hotelCode)).size;
}

/** What differs from a plain month: corrections of approved items, flags, a carried balance. */
export function deviations(s: CommissionStatementPreview) {
  return {
    corrections: s.items.filter((i) => i.kind === 'CORRECTION'),
    flags: s.flags,
    carriedIn: s.openingBalance.startsWith('-') ? s.openingBalance : null,
    blocked: s.flags.length > 0,
  };
}

/**
 * The invoice base as typed ("1 234,5", "1234.50") → "1234.50"; null if it is not a non-negative
 * amount with at most 2 decimals. Never rounded; the server compares it exactly.
 */
export function invoiceBase(input: string): string | null {
  const v = input.replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  return `${String(BigInt(m[1]!))}.${(m[2] ?? '').padEnd(2, '0')}`;
}

/** A refusal code → its Czech text from the given table, else the fallback. */
export function refusalText(
  table: Record<string, string>,
  code: string | null | undefined,
  fallback: string,
): string {
  return (code && table[code]) || fallback;
}

/**
 * What an approval failure may honestly say (doc 069 §5d). A definite refusal is the server's
 * answer for this request. FINANCE_DEPENDENCY_UNAVAILABLE (503) comes only from the core read
 * BEFORE anything is written, so this attempt approved nothing — unless an earlier attempt ended
 * without an answer: that one may have been committed, and with the core down the result cannot
 * be checked. Any other 5xx or a lost answer is never "nothing approved".
 */
export type ApprovalOutcome =
  | { kind: 'refused'; code: string | null }
  | { kind: 'dependencyNothingWritten' }
  | { kind: 'dependencyAfterUncertain' }
  | { kind: 'uncertain' };

export function approvalOutcome(
  code: string | null | undefined,
  uncertainError: boolean,
  earlierUncertain: boolean,
): ApprovalOutcome {
  if (code === 'FINANCE_DEPENDENCY_UNAVAILABLE')
    return earlierUncertain
      ? { kind: 'dependencyAfterUncertain' }
      : { kind: 'dependencyNothingWritten' };
  if (uncertainError) return { kind: 'uncertain' };
  return { kind: 'refused', code: code ?? null };
}
