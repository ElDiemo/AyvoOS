import { createHash } from 'node:crypto';
import type { CommissionMode, FinanceCommissionHotel } from '@ayvo/types';
import { domainError } from '../common/domain-error.js';

/**
 * The commission closing's calculation (doc 069 §5a–§5c), pure: no database, no network. A port
 * of the approved isolated model `docs/prototypes/069-commission-closing.mjs` (#195, 24/24).
 * Money in hundredths (exact integers); rates as '20.00'. The hotel's payment is never an input.
 */

/** O1: live invoice kinds a LIVE statement accepts — none exist yet (doc 040 §5, §13). */
export const LIVE_INVOICE_KINDS: readonly string[] = Object.freeze([]);

/** '4820.00' → 482000. Refuses more than 2 decimals (never a float). */
export function cents(text: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`amount not exact: ${text}`);
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}
export function money(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
/** base × rate %, per line, half-up to 0.01 (O9 — to be confirmed by the accountant before LIVE). */
export function commission(baseCents: number, rate: string): number {
  const v = Math.floor((Math.abs(baseCents) * cents(rate) + 5000) / 10000);
  return baseCents < 0 ? -v : v;
}

export const monthNumber = (start: string, month: string) => {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [y, m] = month.split('-').map(Number) as [number, number];
  return (y - sy) * 12 + (m - sm) + 1;
};
export const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
/** O12: month M may be previewed and approved from the 1st of M+1 (Europe/Prague). */
export const closedBy = (month: string, today: string) => today >= `${nextMonth(month)}-01`;

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A Finance invoice line with what the closing needs (doc 069 §2). */
export interface ClosingLine {
  invoiceId: string;
  invoiceNumber: string;
  invoiceKind: string;
  currency: string;
  lineNo: number;
  periodMonth: string;
  hotelId: string;
  hotelCode: string;
  amount: string;
  cancelled: boolean;
}

/** An item already in an approved statement (doc 069 §5). */
export interface BookedItem {
  statementPeriod: string;
  salespersonId: string;
  salespersonName: string;
  kind: 'REGULAR' | 'CORRECTION';
  cause: string;
  invoiceId: string;
  lineNo: number;
  base: number;
  rate: string;
  k: number;
  amount: number;
  attributionRevision: number;
  bindingId: string;
  termsVersion: number;
}

/** The latest approved statement of a salesperson (per currency and mode). */
export interface LatestStatement {
  id: string;
  periodMonth: string;
  carriedForward: number;
}

export interface ComputedItem {
  kind: 'REGULAR' | 'CORRECTION';
  cause: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceKind: string;
  lineNo: number;
  hotelId: string;
  hotelCode: string;
  serviceMonth: string;
  base: number;
  rate: string;
  k: number;
  amount: number;
  attributionRevision: number;
  bindingId: string;
  termsVersion: number;
}
export interface ComputedFlag {
  code:
    'TERMS_MISSING' | 'CURRENCY_UNSUPPORTED' | 'BEFORE_COMMISSION_START' | 'EARLIER_PERIOD_OPEN';
  invoiceNumber: string;
  hotelCode: string;
  serviceMonth: string;
  dueMonth: string | null;
}
export interface ComputedStatement {
  salespersonId: string;
  salespersonName: string;
  currency: string;
  previous: LatestStatement | null;
  opening: number;
  items: ComputedItem[];
  flags: ComputedFlag[];
  total: number;
  closing: number;
  amountToInvoice: number;
  carriedForward: number;
  fingerprint: string;
}
export interface UnresolvedLine {
  reason: 'UNASSIGNED' | 'BEFORE_COMMISSION_START';
  invoiceNumber: string;
  hotelCode: string;
  serviceMonth: string;
}

export interface ClosingInput {
  month: string;
  mode: CommissionMode;
  /** Lines of months ≤ M of the allowed kinds: valid ones, and every booked one. */
  lines: readonly ClosingLine[];
  booked: readonly BookedItem[];
  /** (salespersonId, currency) → latest statement in this mode. */
  latest: (salespersonId: string, currency: string) => LatestStatement | null;
  /** The core contract's answers per billed month (doc 069 §4). */
  answers: ReadonlyMap<string, ReadonlyMap<string, FinanceCommissionHotel>>;
}

/** Lines whose sources the closing must read for M (the caller then asks the core). */
export function linesToEvaluate(
  month: string,
  mode: CommissionMode,
  lines: readonly ClosingLine[],
  booked: readonly BookedItem[],
): ClosingLine[] {
  const keys = new Set(booked.map((b) => `${b.invoiceId}#${b.lineNo}`));
  return lines.filter(
    (l) =>
      allowedKind(mode, l.invoiceKind) &&
      l.periodMonth <= month &&
      (keys.has(`${l.invoiceId}#${l.lineNo}`) || !l.cancelled),
  );
}

export const allowedKind = (mode: CommissionMode, kind: string) =>
  mode === 'TEST' ? kind === 'TEST' : LIVE_INVOICE_KINDS.includes(kind);

type Person = { salespersonId: string; displayName: string };
type Desired =
  | { state: 'NONE' }
  | { state: 'UNRESOLVED'; reason: 'UNASSIGNED' | 'BEFORE_COMMISSION_START' }
  | { state: 'FLAG'; code: ComputedFlag['code']; sp: Person }
  | {
      state: 'OK';
      sp: Person;
      base: number;
      rate: string;
      k: number;
      amount: number;
      attributionRevision: number;
      bindingId: string;
      termsVersion: number;
    };

function desiredOf(l: ClosingLine, h: FinanceCommissionHotel | undefined): Desired {
  if (l.cancelled) return { state: 'NONE' };
  const a = h?.attribution ?? null;
  if (!a) {
    // Before the first paid month no revision is in force; that is not "unassigned".
    if (h?.commissionStart && h.commissionStart > l.periodMonth)
      return { state: 'UNRESOLVED', reason: 'BEFORE_COMMISSION_START' };
    return { state: 'UNRESOLVED', reason: 'UNASSIGNED' };
  }
  if (a.recipient === null) return { state: 'NONE' }; // Firemní hotel – bez provize
  const sp = a.recipient;
  if (l.currency !== 'CZK') return { state: 'FLAG', code: 'CURRENCY_UNSUPPORTED', sp }; // O6
  if (!a.binding) return { state: 'FLAG', code: 'TERMS_MISSING', sp };
  const k = monthNumber(a.commissionStart, l.periodMonth);
  if (k < 1) return { state: 'FLAG', code: 'BEFORE_COMMISSION_START', sp };
  const rate = k <= a.binding.initialMonths ? a.binding.initialRate : a.binding.maintenanceRate;
  const base = cents(l.amount);
  return {
    state: 'OK',
    sp,
    base,
    rate,
    k,
    amount: commission(base, rate),
    attributionRevision: a.revision,
    bindingId: a.binding.bindingId,
    termsVersion: a.binding.termsVersion,
  };
}

/**
 * The statements due in M (doc 069 §5a–§5c), per salesperson × currency, with items, flags,
 * balance and the fingerprint of that salesperson's own sources; plus lines nobody gets yet.
 */
export function computeClosing(input: ClosingInput): {
  statements: ComputedStatement[];
  unresolved: UnresolvedLine[];
} {
  const { month, mode, answers } = input;
  const booked = new Map<string, BookedItem[]>();
  for (const b of input.booked) {
    const key = `${b.invoiceId}#${b.lineNo}`;
    booked.set(key, [...(booked.get(key) ?? []), b]);
  }
  type Pending = {
    sp: Person;
    currency: string;
    earliest: string;
    item?: ComputedItem;
    flag?: ComputedFlag;
  };
  const pending: Pending[] = [];
  const unresolved: UnresolvedLine[] = [];

  for (const l of linesToEvaluate(month, mode, input.lines, input.booked)) {
    const want = desiredOf(l, answers.get(l.periodMonth)?.get(l.hotelId));
    const before = booked.get(`${l.invoiceId}#${l.lineNo}`) ?? [];
    const show = {
      invoiceNumber: l.invoiceNumber,
      hotelCode: l.hotelCode,
      serviceMonth: l.periodMonth,
    };
    const src = {
      invoiceId: l.invoiceId,
      invoiceKind: l.invoiceKind,
      lineNo: l.lineNo,
      hotelId: l.hotelId,
      ...show,
    };
    // Earliest month: a new line → its billed month (O5); a booked line → the month after the
    // statement of its original REGULAR item (fixed; §5b).
    const regular = before.find((b) => b.kind === 'REGULAR');
    const earliest = regular ? nextMonth(regular.statementPeriod) : l.periodMonth;

    if (want.state === 'UNRESOLVED') {
      unresolved.push({ reason: want.reason, ...show });
      continue;
    }
    if (want.state === 'FLAG') {
      pending.push({
        sp: want.sp,
        currency: l.currency,
        earliest,
        flag: { code: want.code, ...show, dueMonth: null },
      });
      continue;
    }
    if (before.length === 0) {
      if (want.state === 'OK')
        pending.push({
          sp: want.sp,
          currency: l.currency,
          earliest,
          item: {
            kind: 'REGULAR',
            cause: 'REGULAR',
            ...src,
            base: want.base,
            rate: want.rate,
            k: want.k,
            amount: want.amount,
            attributionRevision: want.attributionRevision,
            bindingId: want.bindingId,
            termsVersion: want.termsVersion,
          },
        });
      continue;
    }
    // Booked: the difference between the sources now and what was approved, per salesperson.
    const people = new Map<string, Person>(
      before.map((b) => [
        b.salespersonId,
        { salespersonId: b.salespersonId, displayName: b.salespersonName },
      ]),
    );
    if (want.state === 'OK') people.set(want.sp.salespersonId, want.sp);
    for (const sp of people.values()) {
      const own = before.filter((b) => b.salespersonId === sp.salespersonId);
      const got = own.reduce((s, b) => s + b.amount, 0);
      const gotBase = own.reduce((s, b) => s + b.base, 0);
      const wanted =
        want.state === 'OK' && want.sp.salespersonId === sp.salespersonId ? want : null;
      const delta = (wanted?.amount ?? 0) - got;
      if (delta === 0) continue;
      const last = own.at(-1);
      const basis = wanted ?? last!;
      pending.push({
        sp,
        currency: l.currency,
        earliest,
        item: {
          kind: 'CORRECTION',
          // DB: UNIQUE (invoice_id, line_no, mode, salesperson_id, cause) — one storno per item.
          cause: l.cancelled
            ? 'CANCELLED'
            : `REATTRIBUTED:${want.state === 'OK' ? want.attributionRevision : (answers.get(l.periodMonth)?.get(l.hotelId)?.attribution?.revision ?? 0)}`,
          ...src,
          base: (wanted?.base ?? 0) - gotBase,
          rate: basis.rate,
          k: basis.k,
          amount: delta,
          attributionRevision: basis.attributionRevision,
          bindingId: basis.bindingId,
          termsVersion: basis.termsVersion,
        },
      });
    }
  }

  // §5a: due = earliest, or the month after the salesperson's latest statement if that is later.
  const out = new Map<
    string,
    Omit<
      ComputedStatement,
      'total' | 'closing' | 'amountToInvoice' | 'carriedForward' | 'fingerprint'
    >
  >();
  for (const p of pending) {
    const last = input.latest(p.sp.salespersonId, p.currency);
    const due = last && last.periodMonth >= p.earliest ? nextMonth(last.periodMonth) : p.earliest;
    if (due > month) continue;
    const key = `${p.sp.salespersonId}|${p.currency}`;
    if (!out.has(key))
      out.set(key, {
        salespersonId: p.sp.salespersonId,
        salespersonName: p.sp.displayName,
        currency: p.currency,
        previous: last,
        opening: last?.carriedForward ?? 0,
        items: [],
        flags: [],
      });
    const st = out.get(key)!;
    if (due < month) {
      const what = p.item ?? p.flag!;
      st.flags.push({
        code: 'EARLIER_PERIOD_OPEN',
        invoiceNumber: what.invoiceNumber,
        hotelCode: what.hotelCode,
        serviceMonth: what.serviceMonth,
        dueMonth: due,
      });
    } else if (p.item) st.items.push(p.item);
    else st.flags.push(p.flag!);
  }

  const statements = [...out.values()].map((s): ComputedStatement => {
    s.items.sort(
      (a, b) =>
        a.invoiceNumber.localeCompare(b.invoiceNumber) ||
        a.lineNo - b.lineNo ||
        a.cause.localeCompare(b.cause),
    );
    s.flags.sort(
      (a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber) || a.code.localeCompare(b.code),
    );
    const total = s.items.reduce((a, i) => a + i.amount, 0);
    const closing = s.opening + total;
    return {
      ...s,
      total,
      closing,
      // §5c: a negative result is never an amount to invoice; it is carried (O13).
      amountToInvoice: Math.max(0, closing),
      carriedForward: Math.min(0, closing),
      fingerprint: statementFingerprint(month, mode, s),
    };
  });
  statements.sort(
    (a, b) =>
      a.salespersonName.localeCompare(b.salespersonName, 'cs') ||
      a.salespersonId.localeCompare(b.salespersonId) ||
      a.currency.localeCompare(b.currency),
  );
  unresolved.sort(
    (a, b) =>
      a.serviceMonth.localeCompare(b.serviceMonth) ||
      a.invoiceNumber.localeCompare(b.invoiceNumber),
  );
  return { statements, unresolved };
}

/** Only this salesperson's own sources: approving someone else never makes it stale. */
function statementFingerprint(
  month: string,
  mode: CommissionMode,
  s: {
    salespersonId: string;
    currency: string;
    previous: LatestStatement | null;
    opening: number;
    items: ComputedItem[];
    flags: ComputedFlag[];
  },
): string {
  return sha([
    month,
    mode,
    s.salespersonId,
    s.currency,
    s.previous?.id ?? null,
    s.opening,
    s.items
      .map((i) =>
        JSON.stringify([
          i.kind,
          i.cause,
          i.invoiceId,
          i.lineNo,
          i.base,
          i.attributionRevision,
          i.bindingId,
          i.rate,
          i.k,
          i.amount,
        ]),
      )
      .sort(),
    s.flags.map((f) => JSON.stringify([f.code, f.invoiceNumber, f.dueMonth])).sort(),
  ]);
}

export const monthNotClosed = () =>
  domainError(422, 'MONTH_NOT_CLOSED', 'Měsíc lze uzavřít až od 1. dne následujícího měsíce.');
