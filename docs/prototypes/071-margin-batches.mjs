// Doc 071 §3.6 / ADR 0049 §4 — reading a large volume of core activity over several calls, with
// a hard total deadline, and how a partial, unreconciled or changing source is marked.
// PROPOSAL: an isolated model over a fake core; no database, no network, nothing imported by the
// application. All limits are proposals.
//
// Why a time watermark is not enough (re-review 2026-11-20): PostgreSQL's now() is the start of
// the writing transaction. A transaction that started before the first page and commits between
// two pages has rows with recorded_at ≤ the watermark that the first page could not see, so the
// later pages see "half" of it. The same holds for a sequence: its value is taken at the insert,
// before the commit, so a keyset cursor over seq can skip a row for ever. The test file shows
// both. Two workable answers, neither holds a DB transaction across the network:
//
//   Variant S — a stable listing over several calls: the first call returns the core's
//     pg_current_snapshot(); every later call filters rows by
//     pg_visible_in_snapshot(row.created_xid, snapshot). Needs an xid8 column written by
//     pg_current_xact_id() on every append-only source table (a core migration). Modelled by
//     takeSnapshot / visibleInSnapshot below.
//   Variant H (recommended for v1, no core schema change) — whole hotels per call: every call
//     reads its hotels completely in ONE short read-only transaction (REPEATABLE READ), so each
//     hotel's core activity is internally consistent as of that call's readAt. Different hotels
//     may be of different moments. v1 shows hotels one by one and NO sum over hotels: a core
//     verification could not cover Finance's own inputs (revenue, commissions, prices, rates),
//     so there is no common Finance + core moment to claim (re-review 2026-11-20).
//
// The fingerprint covers every value that changes money (hotel, crate cycle, kind, days,
// quantities, units, item and state), not only keys and counts: the same keys and counts with a
// changed quantity are a different fingerprint.

export const DEFAULT_LIMITS = Object.freeze({
  maxHotelsPerCall: 200, // like the commission contract
  maxRowsPerPage: 1000, // a page holds whole hotels only, up to this many circulations
  callTimeoutMs: 10_000, // one call — never more than the remaining total budget
  deadlineMs: 60_000, // hard total budget of the whole overview build, checked before every try
  retriesPerPage: 1, // a read is idempotent; one retry if the budget allows it
});

export class SourceTimeout extends Error {}

// --- Variant S: PostgreSQL snapshot visibility ---------------------------------------------------

/** pg_current_snapshot(): xmin, xmax and the transactions in progress (xip). */
export function takeSnapshot(db) {
  const inProgress = db.transactions.filter((t) => t.state === 'IN_PROGRESS').map((t) => t.xid);
  const xmax = db.nextXid;
  return { xmin: inProgress.length ? Math.min(...inProgress) : xmax, xmax, xip: inProgress };
}

/** pg_visible_in_snapshot(xid, snap): the writer had finished when the snapshot was taken. */
export function visibleInSnapshot(xid, snap) {
  return xid < snap.xmin || (xid < snap.xmax && !snap.xip.includes(xid));
}

// --- Variant H: whole hotels per call, no sum over hotels in v1 ----------------------------------

/**
 * Canonical fingerprint of one hotel's activity over every money-relevant value (the core
 * computes the same, e.g. SHA-256 over this canonical text). Field order is fixed; rows are
 * sorted by their key.
 */
export function fingerprintOf(h) {
  const line = (tag, o, fields) => `${tag}:${fields.map((f) => `${f}=${o[f] ?? ''}`).join(',')}`;
  const rows = [
    `H:hotelId=${h.hotelId}`,
    ...h.dispatches.map((d) =>
      line('D', d, ['crateCycleId', 'hotelId', 'dispatchedOn', 'bottleCount', 'status']),
    ),
    ...h.returns.map((r) =>
      line('R', r, ['returnLineId', 'kind', 'crateCycleId', 'hotelId', 'scannedOn']),
    ),
    ...h.circulations.flatMap((c) => [
      line('C', c, ['crateCycleId', 'bottleId', 'kind']),
      ...(c.consumed ?? []).map((u) =>
        line(`M:${c.crateCycleId}:${c.bottleId}`, u, [
          'movementId',
          'item',
          'itemKind',
          'unit',
          'qty',
          'on',
        ]),
      ),
    ]),
  ].sort();
  return rows.join('|');
}

/**
 * Reads `hotelIds` for `month`. Per hotel:
 *   COMPLETE      read whole in one call; counts and the value fingerprint agree — valid as of
 *                 its own readAt (core part only; Finance's inputs carry their own read moment)
 *   PARTIAL       not read: NOT_READ, DEADLINE, SOURCE_UNAVAILABLE — never computed
 *   UNRECONCILED  read but does not add up: COUNT_MISMATCH, CRATE_COUNT_MISMATCH, FOREIGN_CRATE,
 *                 FINGERPRINT_MISMATCH, DUPLICATE_HOTEL — never computed
 * There is no sum over hotels in v1 (`aggregate` says so explicitly).
 * `fetchPage(request, timeoutMs)` may throw SourceTimeout; `clock` is injected ({ now(): ms }).
 */
export function readActivity(fetchPage, { month, hotelIds, clock, limits = DEFAULT_LIMITS }) {
  const start = clock.now();
  const left = () => limits.deadlineMs - (clock.now() - start);
  const tries = [];

  /** One request under the hard budget: every try gets at most the remaining budget. */
  const call = (request) => {
    for (let attempt = 0; attempt <= limits.retriesPerPage; attempt++) {
      const budget = left();
      if (budget <= 0) return { failed: 'DEADLINE' };
      const timeoutMs = Math.min(limits.callTimeoutMs, budget);
      tries.push({ request, timeoutMs });
      try {
        return { value: fetchPage(request, timeoutMs) };
      } catch (e) {
        if (!(e instanceof SourceTimeout)) throw e;
      }
    }
    return { failed: left() <= 0 ? 'DEADLINE' : 'SOURCE_UNAVAILABLE' };
  };

  const hotels = Object.fromEntries(
    hotelIds.map((id) => [id, { state: 'PARTIAL', reasons: ['NOT_READ'] }]),
  );
  for (let i = 0; i < hotelIds.length; i += limits.maxHotelsPerCall) {
    const chunk = hotelIds.slice(i, i + limits.maxHotelsPerCall);
    let cursor = null;
    for (;;) {
      const r = call({ month, hotelIds: chunk, cursor });
      if (r.failed) {
        for (const id of chunk)
          if (hotels[id].reasons[0] === 'NOT_READ')
            hotels[id] = { state: 'PARTIAL', reasons: [r.failed] };
        break;
      }
      const page = r.value;
      const seen = new Set();
      for (const h of page.hotels) {
        if (seen.has(h.hotelId)) {
          hotels[h.hotelId] = { state: 'UNRECONCILED', reasons: ['DUPLICATE_HOTEL'] };
          continue;
        }
        seen.add(h.hotelId);
        const mismatch = reconcile(h);
        hotels[h.hotelId] = mismatch.length
          ? { state: 'UNRECONCILED', reasons: mismatch }
          : {
              state: 'COMPLETE',
              reasons: [],
              readAt: page.readAt,
              fingerprint: h.fingerprint,
              activity: h,
            };
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }
  return {
    hotels,
    // v1: no sum over hotels — no common moment of Finance and the core is claimed (ADR 0049 §4).
    aggregate: { offered: false, reason: 'NOT_IN_V1' },
    tries,
    elapsedMs: clock.now() - start,
  };
}

/** The core's own totals and fingerprint must match what arrived, crate by crate. */
function reconcile(h) {
  const out = [];
  if (
    h.dispatches.length !== h.totals.dispatches ||
    h.returns.length !== h.totals.returns ||
    h.circulations.length !== h.totals.circulations
  )
    out.push('COUNT_MISMATCH');
  const perCrate = new Map(h.dispatches.map((d) => [d.crateCycleId, 0]));
  for (const c of h.circulations) {
    if (!perCrate.has(c.crateCycleId)) out.push('FOREIGN_CRATE');
    else perCrate.set(c.crateCycleId, perCrate.get(c.crateCycleId) + 1);
  }
  for (const d of h.dispatches)
    if (perCrate.get(d.crateCycleId) !== d.bottleCount) out.push('CRATE_COUNT_MISMATCH');
  if (fingerprintOf(h) !== h.fingerprint) out.push('FINGERPRINT_MISMATCH');
  return [...new Set(out)];
}

/** Summary for the admin (doc 071 §3.6): how much of the source is in, never a margin. */
export function sourceSummary(read) {
  const counts = { COMPLETE: 0, PARTIAL: 0, UNRECONCILED: 0 };
  for (const h of Object.values(read.hotels)) counts[h.state]++;
  return {
    ...counts,
    total: Object.keys(read.hotels).length,
  };
}
