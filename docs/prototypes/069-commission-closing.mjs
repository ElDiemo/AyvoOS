// Doc 069 §8 — an isolated model of the Finance commission closing (owner rule 2026-11-18).
// Pure functions and an in-memory store; no database, no network, nothing imported by the
// application. Inputs are shaped like the real rows (doc 069 §2: finance.invoices +
// invoice_lines + invoice_cancellations) and the proposed core contract (doc 069 §4).
// The hotel's payment is NOT an input: a line may carry payment data and it is ignored.
import { createHash } from 'node:crypto';

/** Live invoice kinds a LIVE statement accepts (O1): none exist today, so the list is empty. */
export const LIVE_KINDS = Object.freeze([]);

export class ClosingError extends Error {
  constructor(code, status, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.status = status;
  }
}

// --- exact money -------------------------------------------------------------------------------

/** '4820.00' → 482000 (hundredths). Refuses more than 2 decimals. */
export function cents(text) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new ClosingError('AMOUNT_INVALID', 422, text);
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}
export const text = (c) => {
  const s = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${s}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};
/** base × rate %, per line, half-up to 0.01 (O9). Rate '20.00' = 2000 hundredths of a percent. */
export function commission(baseCents, rateText) {
  const r = cents(rateText);
  const num = Math.abs(baseCents) * r; // hundredths × hundredths-of-% → 10^-6 of the currency
  const v = Math.floor((num + 5000) / 10000);
  return baseCents < 0 ? -v : v;
}

// --- months ------------------------------------------------------------------------------------

export const monthNumber = (start, month) => {
  const [sy, sm] = start.split('-').map(Number);
  const [y, m] = month.split('-').map(Number);
  return (y - sy) * 12 + (m - sm) + 1;
};
export const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
/** O12: month M may be approved from the 1st of M+1. */
export const closedBy = (month, today) => today >= `${nextMonth(month)}-01`;

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// --- the store (Finance's own tables, append-only) ---------------------------------------------

export function createStore() {
  return { statements: [], items: [], events: [], operations: new Map() };
}

const regularOf = (store, line) =>
  store.items.find(
    (i) => i.kind === 'REGULAR' && i.invoiceId === line.invoiceId && i.lineNo === line.lineNo,
  );

// --- the calculation ---------------------------------------------------------------------------

/**
 * The preview of month M (no write). `lines`: Finance's own invoice lines; `contract(month,
 * hotelIds)`: the core contract (may throw ClosingError UNAVAILABLE). Returns the statements per
 * salesperson × currency with their items, flags and fingerprint, plus lines without attribution.
 */
export function preview({ month, mode, lines, contract, store, today }) {
  if (!closedBy(month, today)) throw new ClosingError('MONTH_NOT_CLOSED', 422);
  const allowed = (l) => (mode === 'TEST' ? l.kind === 'TEST' : LIVE_KINDS.includes(l.kind));
  const approvedFor = (period, salespersonId) =>
    store.statements.some(
      (s) => s.periodMonth === period && s.salespersonId === salespersonId && s.mode === mode,
    );

  // Candidates: valid lines of M, and late lines of earlier months (O5), never included yet.
  const candidates = lines.filter(
    (l) => allowed(l) && l.cancelledAt === null && !regularOf(store, l) && l.periodMonth <= month,
  );
  const byPeriod = new Map();
  for (const l of candidates)
    byPeriod.set(l.periodMonth, [...(byPeriod.get(l.periodMonth) ?? []), l]);
  const answers = new Map();
  for (const [period, ls] of byPeriod)
    answers.set(period, contract(period, [...new Set(ls.map((l) => l.hotelId))])); // may throw → nothing written

  const out = new Map();
  const unassigned = [];
  const slot = (sp, currency) => {
    const key = `${sp.salespersonId}|${currency}`;
    if (!out.has(key))
      out.set(key, {
        periodMonth: month,
        salespersonId: sp.salespersonId,
        displayName: sp.displayName,
        currency,
        mode,
        items: [],
        flags: [],
      });
    return out.get(key);
  };

  for (const l of candidates) {
    const answer = answers.get(l.periodMonth);
    const a = answer.hotels.find((h) => h.hotelId === l.hotelId)?.attribution ?? null;
    if (!a) {
      if (l.periodMonth === month)
        unassigned.push({ invoiceNumber: l.invoiceNumber, hotelCode: l.hotelCode });
      continue;
    }
    if (a.recipient === null) continue; // Firemní hotel – bez provize
    // A late line of an earlier month only once that month's statement exists (O5); otherwise it
    // waits for its own month.
    if (l.periodMonth < month && !approvedFor(l.periodMonth, a.recipient.salespersonId)) continue;
    const st = slot(a.recipient, l.currency);
    const flag = (code) =>
      st.flags.push({ code, hotelCode: l.hotelCode, invoiceNumber: l.invoiceNumber });
    if (l.currency !== 'CZK') {
      flag('CURRENCY_UNSUPPORTED');
      continue;
    }
    if (!a.binding) {
      flag('TERMS_MISSING');
      continue;
    }
    const k = monthNumber(a.commissionStart, l.periodMonth);
    if (k < 1) {
      flag('BEFORE_COMMISSION_START');
      continue;
    }
    const phase = k <= a.binding.initialMonths ? 'INITIAL' : 'MAINTENANCE';
    const rate = phase === 'INITIAL' ? a.binding.initialRate : a.binding.maintenanceRate;
    const base = cents(l.amount);
    st.items.push({
      kind: 'REGULAR',
      invoiceId: l.invoiceId,
      lineNo: l.lineNo,
      invoiceKind: l.kind,
      serviceMonth: l.periodMonth,
      hotelCode: l.hotelCode,
      base,
      attributionRevision: a.revision,
      bindingId: a.binding.bindingId,
      termsVersion: a.binding.termsVersion,
      k,
      rate,
      amount: commission(base, rate),
    });
  }

  // Cancellations after approval (O4): a negative correction for the original salesperson.
  for (const i of store.items.filter((x) => x.kind === 'REGULAR')) {
    const l = lines.find((x) => x.invoiceId === i.invoiceId && x.lineNo === i.lineNo);
    const corrected = store.items.some((x) => x.kind === 'CORRECTION' && x.correctsItem === i.id);
    const st0 = store.statements.find((s) => s.id === i.statementId);
    if (!l || l.cancelledAt === null || corrected || st0.mode !== mode) continue;
    const st = slot(
      { salespersonId: st0.salespersonId, displayName: st0.displayName },
      st0.currency,
    );
    st.items.push({
      ...i,
      id: undefined,
      statementId: undefined,
      kind: 'CORRECTION',
      correctsItem: i.id,
      base: -i.base,
      amount: -i.amount,
    });
  }

  const statements = [...out.values()].map((s) => {
    const total = s.items.reduce((a, i) => a + i.amount, 0);
    // Only this salesperson's own sources: approving someone else never makes it stale.
    const fingerprint = sha(
      s.items
        .map((i) => [
          i.kind,
          i.invoiceId,
          i.lineNo,
          i.base,
          i.attributionRevision,
          i.bindingId,
          i.rate,
          i.amount,
        ])
        .concat(s.flags.map((f) => ['FLAG', f.code, f.invoiceNumber]))
        .map((x) => JSON.stringify(x))
        .sort(),
    );
    return { ...s, total, fingerprint };
  });
  return { month, mode, statements, unassigned };
}

// --- approval ----------------------------------------------------------------------------------

/**
 * Approve one salesperson's statement (doc 069 §5): recompute outside the "transaction", compare
 * the fingerprint the admin saw, then (atomically) idempotency, uniqueness and the insert.
 */
export function approve(req, deps) {
  const done = deps.store.operations.get(req.requestId);
  if (done) {
    if (done.payload !== JSON.stringify(req)) throw new ClosingError('IDEMPOTENCY_CONFLICT', 409);
    return done.result; // a replay after a lost answer
  }
  const p = preview({ ...deps, month: req.month, mode: req.mode });
  const st = p.statements.find(
    (s) => s.salespersonId === req.salespersonId && s.currency === req.currency,
  );
  const existing = deps.store.statements.find(
    (s) =>
      s.periodMonth === req.month &&
      s.salespersonId === req.salespersonId &&
      s.currency === req.currency &&
      s.mode === req.mode,
  );
  if (existing) throw new ClosingError('ALREADY_APPROVED', 409, existing.id);
  if (!st) throw new ClosingError('NOTHING_TO_APPROVE', 422);
  if (st.fingerprint !== req.fingerprint) throw new ClosingError('STATEMENT_STALE', 409);
  if (st.flags.length > 0) throw new ClosingError('STATEMENT_FLAGGED', 422);
  if (st.items.length === 0) throw new ClosingError('NOTHING_TO_APPROVE', 422);

  // --- the one Finance transaction ---
  for (const i of st.items) {
    if (req.mode === 'LIVE' && !LIVE_KINDS.includes(i.invoiceKind))
      throw new ClosingError('TEST_IN_LIVE', 422); // DB trigger in the real model
    if (i.kind === 'REGULAR' && regularOf(deps.store, i))
      throw new ClosingError('I1_DUPLICATE', 409);
  }
  const id = `ST-${deps.store.statements.length + 1}`;
  const statement = Object.freeze({
    id,
    periodMonth: req.month,
    salespersonId: st.salespersonId,
    displayName: st.displayName,
    currency: st.currency,
    mode: req.mode,
    total: st.total,
    fingerprint: st.fingerprint,
    approvedBy: req.actorId,
  });
  deps.store.statements.push(statement);
  st.items.forEach((i, n) =>
    deps.store.items.push(Object.freeze({ ...i, id: `${id}/${n + 1}`, statementId: id })),
  );
  deps.store.events.push(Object.freeze({ statementId: id, type: 'APPROVED', by: req.actorId }));
  const result = { id, total: text(st.total) };
  deps.store.operations.set(req.requestId, { payload: JSON.stringify(req), result });
  return result;
}

// --- what a salesperson sees -------------------------------------------------------------------

/** Own statement of M only: the state and one amount; never a hotel's invoice data. */
export function mine(store, viewerId, month, mode = 'TEST') {
  const s = store.statements.find(
    (x) => x.salespersonId === viewerId && x.periodMonth === month && x.mode === mode,
  );
  if (!s) return { month, state: 'PROCESSING' };
  return { month, state: 'APPROVED', amountToInvoice: text(s.total), currency: s.currency };
}

/** The difference between the approved amount and a recomputation — shown, never applied. */
export function approvedVsComputed(store, statementId, recomputedCents) {
  const s = store.statements.find((x) => x.id === statementId);
  return {
    approved: text(s.total),
    computed: text(recomputedCents),
    difference: text(recomputedCents - s.total),
  };
}

/** Payout plan (C12, O11): invoice received by the 10th of M+1 → the 15th of M+1, else the next run. */
export function payoutPlan(month, invoiceReceivedOn) {
  const m1 = nextMonth(month);
  return invoiceReceivedOn <= `${m1}-10` ? `${m1}-15` : `${nextMonth(m1)}-15`;
}
