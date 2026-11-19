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
 * Hotel × month overview. Inputs as the core contract and Finance rows of doc 071 §3:
 *   revenueLines   Finance invoice lines {hotelId, periodMonth, amount, cancelled}
 *   circulations   core: one per bottle filled and dispatched {hotelId, crateCycleId,
 *                  dispatchedOn, bottleId, kind: FIRST_USE|REFILL, consumed: [{item, itemKind,
 *                  unit, qty, on}]} — actual consumption only, no prices
 *   dispatches     core: crates dispatched {hotelId, crateCycleId, dispatchedOn}
 *   returns        core: returned crates received {hotelId, crateCycleId, receivedOn}
 *   commissions    Finance approved statement items {hotelId, serviceMonth, commission,
 *                  approved}
 *   prices         Finance standard prices [{item, unit, price, currency, vat, effectiveFrom,
 *                  recordedAt}]
 *   rates          Finance transport rates [{item: 'OUTBOUND_CRATE'|'RETURN_CRATE', …}]
 */
export function hotelMonth(input, hotelId, month, asOf) {
  const missing = [];
  const lines = [];

  // Revenue: valid invoice lines of the hotel for the billed month (without VAT).
  const revenue = input.revenueLines
    .filter((l) => l.hotelId === hotelId && l.periodMonth === month && !l.cancelled)
    .reduce((s, l) => s + cents(l.amount), 0n);
  const hasRevenue = input.revenueLines.some(
    (l) => l.hotelId === hotelId && l.periodMonth === month && !l.cancelled,
  );
  if (!hasRevenue) missing.push({ kind: 'REVENUE', detail: 'no valid invoice line' });

  // Materials: circulations dispatched to the hotel in the month (PROPOSAL: the dispatch month),
  // each consumption priced on its own day.
  let materials = 0n;
  for (const c of input.circulations) {
    if (c.hotelId !== hotelId || monthOf(c.dispatchedOn) !== month) continue;
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
      lines.push({ kind: 'MATERIAL', item: u.item, circulation: c.kind, cost });
    }
  }

  // Outbound transport: one rate per crate at its dispatch.
  let outbound = 0n;
  for (const d of input.dispatches) {
    if (d.hotelId !== hotelId || monthOf(d.dispatchedOn) !== month) continue;
    const r = priceAt(input.rates, 'OUTBOUND_CRATE', d.dispatchedOn, asOf);
    if (!r) missing.push({ kind: 'RATE', item: 'OUTBOUND_CRATE', on: d.dispatchedOn });
    else outbound += lineCost('1', r.price);
  }

  // Return transport: only when that returned crate is received.
  let returnTransport = 0n;
  for (const r of input.returns) {
    if (r.hotelId !== hotelId || monthOf(r.receivedOn) !== month) continue;
    const rate = priceAt(input.rates, 'RETURN_CRATE', r.receivedOn, asOf);
    if (!rate) missing.push({ kind: 'RATE', item: 'RETURN_CRATE', on: r.receivedOn });
    else returnTransport += lineCost('1', rate.price);
  }

  // Commission: approved statement items of the hotel for the billed month (PROPOSAL).
  const items = input.commissions.filter((i) => i.hotelId === hotelId && i.serviceMonth === month);
  if (items.some((i) => !i.approved))
    missing.push({ kind: 'COMMISSION', detail: 'statement not approved' });
  const commission = items.filter((i) => i.approved).reduce((s, i) => s + cents(i.commission), 0n);

  const complete = missing.length === 0;
  const before = revenue - materials - outbound - returnTransport;
  return {
    hotelId,
    month,
    complete,
    missing,
    revenue: text(revenue),
    costs: {
      materials: text(materials),
      outboundTransport: text(outbound),
      returnTransport: text(returnTransport),
      commission: text(commission),
    },
    // An incomplete month never shows a margin as if it were final (doc 071 §5).
    marginBeforeCommission: complete ? text(before) : null,
    marginAfterCommission: complete ? text(before - commission) : null,
    knownCostsSoFar: text(materials + outbound + returnTransport + commission),
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
