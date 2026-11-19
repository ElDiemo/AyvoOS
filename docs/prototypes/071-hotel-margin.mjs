// Doc 071 / ADR 0049 — an isolated model of the hotel margin overview (hotel × month), first
// DEV version. PROPOSAL: pure functions over fictional data; no database, no network, nothing
// imported by the application.
//
// Owner decisions (2026-11-19) encoded here:
//   - standard prices are entered in Finance and are effective from a date; nothing is valued
//     from goods receipts;
//   - the core supplies only actual consumption and events; Finance prices them;
//   - a new bottle carries its packaging and fill per actual consumption; a refill carries the
//     fill only — the bottle, the label and the reused pump are never counted again;
//   - outbound transport per crate at dispatch; the return rate only at the receipt of that
//     returned crate;
//   - the overview shows revenue, costs (incl. transport and commissions) and the margin
//     before / after commission, separately; a hotel's contribution is not the company result.
// Everything else (CZK without VAT, the validity rule, rounding, the month of a cost, how a
// missing price shows) is marked PROPOSAL in doc 071.

export class MarginError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

// --- exact decimals ------------------------------------------------------------------------------
// Money in hundredths (BigInt), standard prices with up to 4 decimals, quantities with up to 3.

function fixed(text, places, code) {
  const m = new RegExp(`^(-?)(\\d+)(?:\\.(\\d{1,${places}}))?$`).exec(String(text));
  if (!m) throw new MarginError(code, String(text));
  const v = BigInt(m[2]) * 10n ** BigInt(places) + BigInt((m[3] ?? '').padEnd(places, '0'));
  return m[1] ? -v : v;
}
export const cents = (t) => fixed(t, 2, 'AMOUNT_INVALID');
const price4 = (t) => fixed(t, 4, 'PRICE_INVALID');
const qty3 = (t) => fixed(t, 3, 'QUANTITY_INVALID');
export function text(c) {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
/** qty × price, half-up to 0.01 CZK (PROPOSAL: once per cost line). */
function lineCost(qtyText, priceText) {
  const raw = qty3(qtyText) * price4(priceText); // 10^-7 CZK
  const neg = raw < 0n;
  const a = neg ? -raw : raw;
  const c = (a + 50_000n) / 100_000n;
  return neg ? -c : c;
}

// --- standard prices and rates (append-only versions in Finance) ---------------------------------

/**
 * The version in force for `item` on `date` (PROPOSAL, doc 071 §4):
 * the greatest `effectiveFrom` ≤ date; among versions with that same `effectiveFrom`, the latest
 * `recordedAt` that is ≤ `asOf` (a correction recorded later replaces it for recomputations made
 * after it, never silently for an earlier report). Only CZK without VAT.
 */
export function priceAt(versions, item, date, asOf) {
  const candidates = versions.filter(
    (v) => v.item === item && v.effectiveFrom <= date && v.recordedAt <= asOf,
  );
  if (candidates.length === 0) return null;
  for (const v of candidates)
    if (v.currency !== 'CZK' || v.vat !== 'EXCLUDED')
      throw new MarginError('PRICE_NOT_CZK_NET', `${item} ${v.effectiveFrom}`);
  candidates.sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.recordedAt.localeCompare(b.recordedAt)
      : a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  return candidates.at(-1);
}

const monthOf = (day) => day.slice(0, 7);

/** Item kinds a refill must never carry again (owner 2026-11-19). */
const NEVER_ON_REFILL = new Set(['BOTTLE_BODY', 'LABEL']);

/**
 * Every amount has one unique key (PROPOSAL, doc 071 §3.3), so nothing is ever counted twice —
 * not across hotels, months or a repack:
 *   REVENUE:<invoiceLineId>  MATERIAL:<inventoryMovementId>  OUTBOUND:<crateCycleId>
 *   RETURN:<returnReceiptLineId>  COMMISSION:<statementItemId>
 * A duplicate key (or a crate cycle returned twice) is a data error of the whole input, never
 * priced. Checked over the whole input, not only the hotel × month being computed.
 */
export function assertUniqueKeys(input) {
  const seen = new Set();
  const once = (key) => {
    if (seen.has(key)) throw new MarginError('DUPLICATE_COST_KEY', key);
    seen.add(key);
  };
  for (const l of input.revenueLines) once(`REVENUE:${l.lineId}`);
  for (const c of input.circulations) for (const u of c.consumed) once(`MATERIAL:${u.movementId}`);
  for (const d of input.dispatches) once(`OUTBOUND:${d.crateCycleId}`);
  for (const r of input.returns) {
    once(`RETURN:${r.returnLineId}`);
    if (r.crateCycleId) once(`RETURNED_CYCLE:${r.crateCycleId}`);
  }
  for (const i of input.commissionItems) once(`COMMISSION:${i.itemId}`);
}

/**
 * The commission of a hotel × month (PROPOSAL, doc 071 §3.4). Inputs mirror the commission
 * contract (#196) and the Finance statements (#198–#201):
 *   attributions     [{hotelId, month, attribution: null | {commissionStart,
 *                      recipient: null | {salespersonId}}}]  — recipient null = Firemní hotel
 *   statements       [{statementId, salespersonId, month, approved}]
 *   commissionItems  [{itemId, statementId, hotelId, serviceMonth, commission}]
 * States:
 *   NONE_COMPANY_HOTEL  explicitly without commission (Firemní hotel): 0.00, complete
 *   NONE_BEFORE_START   the attribution's commission starts later: 0.00, complete
 *   APPROVED            the recipient's statement for M is approved: the sum of its items (an
 *                       approved statement with no item for the hotel is an explicit 0.00)
 *   NOT_YET_APPROVED    the recipient's statement for M is missing or not approved: incomplete
 *   UNASSIGNED          no attribution in force for M: incomplete
 * An item of this hotel × month in a not yet approved statement (e.g. a later correction) also
 * makes the month incomplete. "Without commission" is never inferred from a missing statement.
 */
function commissionOf(input, hotelId, month) {
  const missing = [];
  const att = input.attributions.find((a) => a.hotelId === hotelId && a.month === month);
  const statementOf = new Map(input.statements.map((s) => [s.statementId, s]));
  const items = input.commissionItems.filter(
    (i) => i.hotelId === hotelId && i.serviceMonth === month,
  );
  let state;
  if (!att || att.attribution === null) state = 'UNASSIGNED';
  else if (att.attribution.recipient === null) state = 'NONE_COMPANY_HOTEL';
  else if (month < att.attribution.commissionStart) state = 'NONE_BEFORE_START';
  else {
    const own = input.statements.find(
      (s) => s.salespersonId === att.attribution.recipient.salespersonId && s.month === month,
    );
    state = own?.approved ? 'APPROVED' : 'NOT_YET_APPROVED';
  }
  if (state === 'UNASSIGNED' || state === 'NOT_YET_APPROVED')
    missing.push({ kind: 'COMMISSION', detail: state });
  else if (items.some((i) => !statementOf.get(i.statementId)?.approved))
    missing.push({ kind: 'COMMISSION', detail: 'CORRECTION_NOT_YET_APPROVED' });
  const approved = items.filter((i) => statementOf.get(i.statementId)?.approved);
  return {
    state,
    missing,
    amount: approved.reduce((s, i) => s + cents(i.commission), 0n),
    lines: approved.map((i) => ({ key: `COMMISSION:${i.itemId}`, cost: cents(i.commission) })),
  };
}

/**
 * Hotel × month overview. Inputs as the core contract and Finance rows of doc 071 §3:
 *   revenueLines   Finance invoice lines {lineId, hotelId, periodMonth, amount, cancelled}
 *   dispatches     core: crates dispatched {crateCycleId, hotelId, dispatchedOn} — the
 *                  recipient of everything in that crate
 *   circulations   core: one per bottle in a dispatched crate {crateCycleId (the crate it was
 *                  dispatched in), bottleId, kind: FIRST_USE|REFILL, filledInCrateCycleId?,
 *                  consumed: [{movementId, item, itemKind, unit, qty, on}]} — actual consumption
 *                  only, no prices, and no hotel of its own: a bottle repacked after filling
 *                  belongs to the hotel of the crate it was dispatched in
 *   returns        core: returned crates received {returnLineId, crateCycleId|null,
 *                  hotelId|null, receivedOn}
 *   attributions, statements, commissionItems   see commissionOf
 *   prices         Finance standard prices [{item, unit, price, currency, vat, effectiveFrom,
 *                  recordedAt}]
 *   rates          Finance transport rates [{item: 'OUTBOUND_CRATE'|'RETURN_CRATE', …}]
 */
export function hotelMonth(input, hotelId, month, asOf) {
  assertUniqueKeys(input);
  const missing = [];
  const lines = [];

  // Revenue: valid invoice lines of the hotel for the billed month (without VAT).
  const revenueRows = input.revenueLines.filter(
    (l) => l.hotelId === hotelId && l.periodMonth === month && !l.cancelled,
  );
  const revenue = revenueRows.reduce((s, l) => s + cents(l.amount), 0n);
  if (revenueRows.length === 0) missing.push({ kind: 'REVENUE', detail: 'no valid invoice line' });

  const dispatchOf = new Map(input.dispatches.map((d) => [d.crateCycleId, d]));

  // Materials: bottles in crates dispatched to the hotel in the month (PROPOSAL: the dispatch
  // month), each consumption priced on its own day. The recipient comes from the dispatch, never
  // from where the bottle was filled: a repack moves no cost and consumes nothing.
  let materials = 0n;
  for (const c of input.circulations) {
    const d = dispatchOf.get(c.crateCycleId);
    if (!d) throw new MarginError('CIRCULATION_NOT_DISPATCHED', `${c.bottleId} ${c.crateCycleId}`);
    if (d.hotelId !== hotelId || monthOf(d.dispatchedOn) !== month) continue;
    for (const u of c.consumed) {
      if (c.kind === 'REFILL' && NEVER_ON_REFILL.has(u.itemKind))
        throw new MarginError('REFILL_CARRIES_PACKAGING', `${c.bottleId} ${u.item}`);
      const p = priceAt(input.prices, u.item, u.on, asOf);
      if (!p || p.unit !== u.unit) {
        missing.push({ kind: 'PRICE', item: u.item, on: u.on, bottleId: c.bottleId });
        continue;
      }
      const cost = lineCost(u.qty, p.price);
      materials += cost;
      lines.push({
        key: `MATERIAL:${u.movementId}`,
        kind: 'MATERIAL',
        item: u.item,
        circulation: c.kind,
        crateCycleId: c.crateCycleId,
        cost,
      });
    }
  }

  // Outbound transport: one rate per crate at its dispatch.
  let outbound = 0n;
  for (const d of input.dispatches) {
    if (d.hotelId !== hotelId || monthOf(d.dispatchedOn) !== month) continue;
    const r = priceAt(input.rates, 'OUTBOUND_CRATE', d.dispatchedOn, asOf);
    if (!r) missing.push({ kind: 'RATE', item: 'OUTBOUND_CRATE', on: d.dispatchedOn });
    else {
      const cost = lineCost('1', r.price);
      outbound += cost;
      lines.push({ key: `OUTBOUND:${d.crateCycleId}`, kind: 'OUTBOUND', cost });
    }
  }

  // Return transport: only when that returned crate is received. A received crate with no hotel
  // (hotelId null) is nobody's cost here (doc 071 Q10).
  let returnTransport = 0n;
  for (const r of input.returns) {
    if (r.hotelId !== hotelId || monthOf(r.receivedOn) !== month) continue;
    const rate = priceAt(input.rates, 'RETURN_CRATE', r.receivedOn, asOf);
    if (!rate) missing.push({ kind: 'RATE', item: 'RETURN_CRATE', on: r.receivedOn });
    else {
      const cost = lineCost('1', rate.price);
      returnTransport += cost;
      lines.push({ key: `RETURN:${r.returnLineId}`, kind: 'RETURN', cost });
    }
  }

  // Commission: explicitly none ≠ not yet approved (commissionOf).
  const commission = commissionOf(input, hotelId, month);
  missing.push(...commission.missing);
  for (const l of commission.lines) lines.push({ ...l, kind: 'COMMISSION' });

  const complete = missing.length === 0;
  const before = revenue - materials - outbound - returnTransport;
  return {
    hotelId,
    month,
    complete,
    missing,
    revenue: text(revenue),
    revenueKeys: revenueRows.map((l) => `REVENUE:${l.lineId}`),
    costs: {
      materials: text(materials),
      outboundTransport: text(outbound),
      returnTransport: text(returnTransport),
      commission: text(commission.amount),
    },
    commissionState: commission.state,
    // An incomplete month never shows a margin as if it were final (doc 071 §5).
    marginBeforeCommission: complete ? text(before) : null,
    marginAfterCommission: complete ? text(before - commission.amount) : null,
    knownCostsSoFar: text(materials + outbound + returnTransport + commission.amount),
    lines,
  };
}

/**
 * The company result is NOT the sum of hotel contributions: rent, the accountant, wages and other
 * overheads are never allocated to a hotel in v1 (doc 071 §6). Shown apart, for contrast only.
 */
export function companyView(hotelRows, overheads) {
  if (hotelRows.some((r) => !r.complete))
    return { complete: false, contributions: null, overheads: null, result: null };
  const contributions = hotelRows.reduce((s, r) => s + cents(r.marginAfterCommission), 0n);
  const over = overheads.reduce((s, o) => s + cents(o.amount), 0n);
  return {
    complete: true,
    contributions: text(contributions),
    overheads: text(over),
    result: text(contributions - over),
  };
}
