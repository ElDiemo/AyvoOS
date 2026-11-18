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
const lineKey = (x) => `${x.invoiceId}#${x.lineNo}`;

// --- the store (Finance's own tables, append-only) ---------------------------------------------

export function createStore() {
  return { statements: [], items: [], events: [], operations: new Map() };
}

/** The salesperson's latest approved statement (per currency and mode), or null. */
const latestOf = (store, salespersonId, currency, mode) =>
  store.statements
    .filter((s) => s.salespersonId === salespersonId && s.currency === currency && s.mode === mode)
    .reduce((a, s) => (a && a.periodMonth >= s.periodMonth ? a : s), null);

/**
 * §5a The due month of a pending item or flag: its earliest month E, but never at or before the
 * salesperson's latest approved statement L — then the month after L. Exactly one month at a
 * time, computed from Finance's own state; no prior or zero statement is needed.
 */
export const dueMonth = (store, salespersonId, currency, mode, earliest) => {
  const last = latestOf(store, salespersonId, currency, mode);
  return last && last.periodMonth >= earliest ? nextMonth(last.periodMonth) : earliest;
};

// --- the calculation ---------------------------------------------------------------------------

/** What the current sources say a line is worth, and to whom (no write). */
function desiredOf(l, a) {
  if (l.cancelledAt !== null) return { state: 'NONE' };
  if (!a) return { state: 'UNRESOLVED', code: 'UNASSIGNED', sp: null };
  if (a.recipient === null) return { state: 'NONE' }; // Firemní hotel – bez provize
  const unresolved = (code) => ({ state: 'UNRESOLVED', code, sp: a.recipient });
  if (l.currency !== 'CZK') return unresolved('CURRENCY_UNSUPPORTED');
  if (!a.binding) return unresolved('TERMS_MISSING');
  const k = monthNumber(a.commissionStart, l.periodMonth);
  if (k < 1) return unresolved('BEFORE_COMMISSION_START');
  const rate = k <= a.binding.initialMonths ? a.binding.initialRate : a.binding.maintenanceRate;
  const base = cents(l.amount);
  return {
    state: 'OK',
    sp: a.recipient,
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
 * The preview of month M (no write). `lines`: Finance's own invoice lines; `contract(month,
 * hotelIds)`: the core contract (may throw ClosingError CORE_UNAVAILABLE). Returns the statements
 * per salesperson × currency due in M with their items, flags, balance and fingerprint, plus the
 * unresolved lines without attribution of any month ≤ M.
 */
export function preview({ month, mode, lines, contract, store, today }) {
  if (!closedBy(month, today)) throw new ClosingError('MONTH_NOT_CLOSED', 422);
  const allowed = (l) => (mode === 'TEST' ? l.kind === 'TEST' : LIVE_KINDS.includes(l.kind));
  const booked = new Map(); // line → items already in approved statements of this mode
  for (const i of store.items.filter((x) => x.mode === mode))
    booked.set(lineKey(i), [...(booked.get(lineKey(i)) ?? []), i]);

  // Lines to evaluate: valid lines of months ≤ M never included, and every line already booked
  // (a cancellation or a corrected attribution yields a correction, §5b).
  const evaluated = lines.filter(
    (l) =>
      allowed(l) && l.periodMonth <= month && (booked.has(lineKey(l)) || l.cancelledAt === null),
  );
  const byPeriod = new Map();
  for (const l of evaluated)
    byPeriod.set(l.periodMonth, [...(byPeriod.get(l.periodMonth) ?? []), l]);
  const answers = new Map();
  for (const [period, ls] of byPeriod)
    answers.set(period, contract(period, [...new Set(ls.map((l) => l.hotelId))])); // may throw → nothing written

  const pending = []; // { sp, currency, earliest, item? , flag? }
  const unassigned = [];
  const statementOf = (id) => store.statements.find((s) => s.id === id);

  for (const l of evaluated) {
    const a = answers.get(l.periodMonth).hotels.find((h) => h.hotelId === l.hotelId)?.attribution;
    const want = desiredOf(l, a ?? null);
    const before = booked.get(lineKey(l)) ?? [];
    const src = { invoiceId: l.invoiceId, lineNo: l.lineNo, invoiceKind: l.kind };
    const show = {
      hotelCode: l.hotelCode,
      invoiceNumber: l.invoiceNumber,
      serviceMonth: l.periodMonth,
    };

    if (before.length === 0) {
      // Never included: a REGULAR item for its own billed month (O5: E = the billed month).
      if (want.state === 'UNRESOLVED' && want.sp === null) unassigned.push({ ...show });
      else if (want.state === 'UNRESOLVED')
        pending.push({
          sp: want.sp,
          currency: l.currency,
          earliest: l.periodMonth,
          flag: { code: want.code, ...show },
        });
      else if (want.state === 'OK')
        pending.push({
          sp: want.sp,
          currency: l.currency,
          earliest: l.periodMonth,
          item: { kind: 'REGULAR', cause: 'REGULAR', ...src, ...show, ...pick(want) },
        });
      continue;
    }

    // Already booked (§5b): the difference between what the sources say now and what was
    // approved, per salesperson. Earliest month: the one after the statement of the original
    // REGULAR item — fixed, so another salesperson's approval never moves it (dueMonth then
    // moves it past this salesperson's own latest statement).
    const regular = before.find((i) => i.kind === 'REGULAR');
    const after = nextMonth(statementOf(regular.statementId).periodMonth);
    if (want.state === 'UNRESOLVED') {
      if (want.sp === null) unassigned.push({ ...show });
      else
        pending.push({
          sp: want.sp,
          currency: l.currency,
          earliest: after,
          flag: { code: want.code, ...show },
        });
      continue;
    }
    const people = new Map(
      before.map((i) => [
        i.salespersonId,
        { salespersonId: i.salespersonId, displayName: i.displayName },
      ]),
    );
    if (want.state === 'OK') people.set(want.sp.salespersonId, want.sp);
    for (const sp of people.values()) {
      const mine = before.filter((i) => i.salespersonId === sp.salespersonId);
      const got = mine.reduce((s, i) => s + i.amount, 0);
      const gotBase = mine.reduce((s, i) => s + i.base, 0);
      const isWanted = want.state === 'OK' && want.sp.salespersonId === sp.salespersonId;
      const delta = (isWanted ? want.amount : 0) - got;
      if (delta === 0) continue;
      const last = mine.at(-1);
      const basis = isWanted ? pick(want) : { ...pick(last), base: 0, amount: 0 };
      pending.push({
        sp,
        currency: l.currency,
        earliest: after,
        item: {
          kind: 'CORRECTION',
          // DB: UNIQUE (invoice_id, line_no, salesperson_id, cause) — one storno per item (§5b).
          cause: l.cancelledAt !== null ? 'CANCELLED' : `REATTRIBUTED:${a.revision}`,
          ...src,
          ...show,
          ...basis,
          base: (isWanted ? want.base : 0) - gotBase,
          amount: delta,
        },
      });
    }
  }

  // Each pending entry is due in exactly one month (§5a). M shows what is due in M; anything due
  // earlier is shown to the admin and blocks this salesperson's M (EARLIER_PERIOD_OPEN).
  const out = new Map();
  const slot = (sp, currency) => {
    const key = `${sp.salespersonId}|${currency}`;
    if (!out.has(key)) {
      const last = latestOf(store, sp.salespersonId, currency, mode);
      out.set(key, {
        periodMonth: month,
        salespersonId: sp.salespersonId,
        displayName: sp.displayName,
        currency,
        mode,
        previousPeriod: last?.periodMonth ?? null,
        opening: last ? last.carriedForward : 0,
        items: [],
        flags: [],
      });
    }
    return out.get(key);
  };
  for (const p of pending) {
    const due = dueMonth(store, p.sp.salespersonId, p.currency, mode, p.earliest);
    if (due > month) continue; // a later month (or not yet closed)
    const st = slot(p.sp, p.currency);
    if (due < month) {
      const what = p.item ? `${p.item.kind}:${p.item.cause}` : p.flag.code;
      st.flags.push({
        code: 'EARLIER_PERIOD_OPEN',
        dueMonth: due,
        what,
        ...pickShow(p.item ?? p.flag),
      });
    } else if (p.item) st.items.push(p.item);
    else st.flags.push(p.flag);
  }

  const statements = [...out.values()].map((s) => {
    const total = s.items.reduce((a, i) => a + i.amount, 0);
    const closing = s.opening + total;
    // Only this salesperson's own sources: approving someone else never makes it stale.
    const fingerprint = sha([
      s.previousPeriod,
      s.opening,
      ...s.items
        .map((i) => [
          i.kind,
          i.cause,
          i.invoiceId,
          i.lineNo,
          i.base,
          i.attributionRevision,
          i.bindingId,
          i.rate,
          i.amount,
        ])
        .concat(s.flags.map((f) => ['FLAG', f.code, f.invoiceNumber, f.dueMonth ?? null]))
        .map((x) => JSON.stringify(x))
        .sort(),
    ]);
    return {
      ...s,
      total,
      closing,
      // §5c A negative result is never an amount to invoice: it is carried to the next statement.
      amountToInvoice: Math.max(0, closing),
      carriedForward: Math.min(0, closing),
      fingerprint,
    };
  });
  return { month, mode, statements, unassigned };
}

const pick = (x) => ({
  base: x.base,
  rate: x.rate,
  k: x.k,
  amount: x.amount,
  attributionRevision: x.attributionRevision,
  bindingId: x.bindingId,
  termsVersion: x.termsVersion,
});
const pickShow = (x) => ({
  hotelCode: x.hotelCode,
  invoiceNumber: x.invoiceNumber,
  serviceMonth: x.serviceMonth,
});

// --- approval ----------------------------------------------------------------------------------

const defaultApprover = (actorId) => actorId === 'admin';

/**
 * Finance's own part of a salesperson's sources (re-read inside the transaction under the lock):
 * the latest statement, the booked items and the cancellation state of every line they touch.
 */
function financeState(deps, req, items) {
  const own = deps.store.items.filter(
    (i) => i.mode === req.mode && i.salespersonId === req.salespersonId,
  );
  const touched = new Set([...own, ...items].map(lineKey));
  return sha([
    latestOf(deps.store, req.salespersonId, req.currency, req.mode)?.id ?? null,
    own.map((i) => i.id),
    deps.lines
      .filter((l) => touched.has(lineKey(l)))
      .map((l) => [lineKey(l), l.cancelledAt !== null]),
  ]);
}

/**
 * Approve step 0–1 (doc 069 §5d), outside any transaction: permission, then a stored result of the
 * same request (same actor and content) is returned without calling the core; otherwise the core
 * is read once and the statement recomputed.
 */
export function prepareApproval(req, deps) {
  if (!(deps.isApprover ?? defaultApprover)(req.actorId)) throw new ClosingError('FORBIDDEN', 403);
  const done = deps.store.operations.get(req.requestId);
  if (done) {
    if (done.payload !== JSON.stringify(req)) throw new ClosingError('IDEMPOTENCY_CONFLICT', 409);
    return { replay: done.result }; // a replay after a lost answer — even with the core down
  }
  orderChecks(req, deps);
  const p = preview({ ...deps, month: req.month, mode: req.mode });
  const st = p.statements.find(
    (s) => s.salespersonId === req.salespersonId && s.currency === req.currency,
  );
  if (!st) throw new ClosingError('NOTHING_TO_APPROVE', 422);
  if (st.fingerprint !== req.fingerprint) throw new ClosingError('STATEMENT_STALE', 409);
  if (st.flags.length > 0) throw new ClosingError('STATEMENT_FLAGGED', 422);
  if (st.items.length === 0) throw new ClosingError('NOTHING_TO_APPROVE', 422);
  return { req, st, finance: financeState(deps, req, st.items), sourcesReadAt: deps.now ?? null };
}

function orderChecks(req, deps) {
  const last = latestOf(deps.store, req.salespersonId, req.currency, req.mode);
  if (last?.periodMonth === req.month) throw new ClosingError('ALREADY_APPROVED', 409, last.id);
  if (last && last.periodMonth > req.month)
    throw new ClosingError('PERIOD_ORDER', 409, last.periodMonth);
}

/**
 * Approve step 2 (doc 069 §5d): ONE Finance transaction under the advisory lock
 * `commission:<mode>:<salesperson>` (all months of one salesperson serialise). JS runs it
 * synchronously; the checks are the ones the transaction repeats.
 */
export function commitApproval(prepared, deps) {
  const { req, st } = prepared;
  const done = deps.store.operations.get(req.requestId); // the same request committed meanwhile
  if (done) {
    if (done.payload !== JSON.stringify(req)) throw new ClosingError('IDEMPOTENCY_CONFLICT', 409);
    return done.result;
  }
  orderChecks(req, deps);
  if (financeState(deps, req, st.items) !== prepared.finance)
    throw new ClosingError('STATEMENT_STALE', 409, 'finance sources changed');
  for (const i of st.items) {
    if (req.mode === 'LIVE' && !LIVE_KINDS.includes(i.invoiceKind))
      throw new ClosingError('TEST_IN_LIVE', 422); // DB trigger in the real model
    const sameLine = deps.store.items.filter(
      (x) => x.mode === req.mode && lineKey(x) === lineKey(i),
    );
    if (i.kind === 'REGULAR' && sameLine.some((x) => x.kind === 'REGULAR'))
      throw new ClosingError('I1_DUPLICATE', 409); // UNIQUE (invoice_id, line_no) WHERE REGULAR
    if (sameLine.some((x) => x.salespersonId === req.salespersonId && x.cause === i.cause))
      throw new ClosingError('CORRECTION_DUPLICATE', 409); // UNIQUE (invoice_id, line_no, salesperson_id, cause)
  }
  const id = `ST-${deps.store.statements.length + 1}`;
  const statement = Object.freeze({
    id,
    periodMonth: req.month,
    salespersonId: st.salespersonId,
    displayName: st.displayName,
    currency: st.currency,
    mode: req.mode,
    opening: st.opening,
    total: st.total,
    closing: st.closing,
    amountToInvoice: st.amountToInvoice,
    carriedForward: st.carriedForward,
    fingerprint: st.fingerprint,
    sourcesReadAt: prepared.sourcesReadAt,
    approvedBy: req.actorId,
  });
  deps.store.statements.push(statement);
  st.items.forEach((i, n) =>
    deps.store.items.push(
      Object.freeze({
        ...i,
        id: `${id}/${n + 1}`,
        statementId: id,
        mode: req.mode,
        salespersonId: st.salespersonId,
        displayName: st.displayName,
      }),
    ),
  );
  deps.store.events.push(Object.freeze({ statementId: id, type: 'APPROVED', by: req.actorId }));
  const result = { id, total: text(st.total), amountToInvoice: text(st.amountToInvoice) };
  deps.store.operations.set(req.requestId, { payload: JSON.stringify(req), result });
  return result;
}

export function approve(req, deps) {
  const p = prepareApproval(req, deps);
  return p.replay ?? commitApproval(p, deps);
}

// --- what a salesperson sees -------------------------------------------------------------------

/** Own statement of M only: the state and one amount; never a hotel's invoice data. */
export function mine(store, viewerId, month, mode = 'TEST') {
  const s = store.statements.find(
    (x) => x.salespersonId === viewerId && x.periodMonth === month && x.mode === mode,
  );
  if (!s) return { month, state: 'PROCESSING' };
  if (s.amountToInvoice > 0)
    return {
      month,
      state: 'APPROVED',
      amountToInvoice: text(s.amountToInvoice),
      currency: s.currency,
    };
  // §5c nothing to invoice; the (negative or zero) balance moves to the next statement.
  return {
    month,
    state: 'NOTHING_TO_INVOICE',
    balanceCarriedForward: text(s.carriedForward),
    currency: s.currency,
  };
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
