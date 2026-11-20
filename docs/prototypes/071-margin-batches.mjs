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
//     hotel is internally consistent as of that call's readAt. Different hotels may be of
//     different moments. A sum over hotels is offered only after one verification call that
//     returns every hotel's fingerprint from one transaction; a hotel that changed is re-read
//     once, and if it still differs the sum is not shown. Modelled by readActivity.

export const DEFAULT_LIMITS = Object.freeze({
  maxHotelsPerCall: 200, // like the commission contract
  maxRowsPerPage: 1000, // a page holds whole hotels only, up to this many circulations
  callTimeoutMs: 10_000, // one call — never more than the remaining total budget
  deadlineMs: 60_000, // hard total budget of the whole overview build, checked before every try
  retriesPerPage: 1, // a read is idempotent; one retry if the budget allows it
  maxHotelsPerVerify: 1000, // one verification call; above it no sum over hotels in v1
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

// --- Variant H: whole hotels per call, verified sum ----------------------------------------------

/** Canonical fingerprint of one hotel's activity (the core computes the same, e.g. SHA-256). */
export function fingerprintOf(h) {
  const keys = [
    ...h.dispatches.map((d) => `D:${d.crateCycleId}:${d.bottleCount}`),
    ...h.returns.map((r) => `R:${r.returnLineId}`),
    ...h.circulations.map((c) => `C:${c.crateCycleId}:${c.bottleId}`),
  ].sort();
  return keys.join('|');
}

/**
 * Reads `hotelIds` for `month`. Per hotel:
 *   COMPLETE      read whole in one call, counts and fingerprint agree — valid as of its readAt
 *   PARTIAL       not read: NOT_READ, DEADLINE, SOURCE_UNAVAILABLE — never computed
 *   UNRECONCILED  read but does not add up: COUNT_MISMATCH, CRATE_COUNT_MISMATCH, FOREIGN_CRATE,
 *                 FINGERPRINT_MISMATCH, DUPLICATE_HOTEL — never computed
 * and `aggregate`: a sum over hotels is allowed only when `consistent` (one verified moment).
 * `fetchPage(request, timeoutMs)` and `verify(request, timeoutMs)` may throw SourceTimeout;
 * `clock` is injected ({ now(): ms }).
 */
export function readActivity(
  fetchPage,
  verify,
  { month, hotelIds, clock, limits = DEFAULT_LIMITS },
) {
  const start = clock.now();
  const left = () => limits.deadlineMs - (clock.now() - start);
  const tries = [];

  /** One request under the hard budget: every try gets at most the remaining budget. */
  const call = (fn, request) => {
    for (let attempt = 0; attempt <= limits.retriesPerPage; attempt++) {
      const budget = left();
      if (budget <= 0) return { failed: 'DEADLINE' };
      const timeoutMs = Math.min(limits.callTimeoutMs, budget);
      tries.push({ request, timeoutMs });
      try {
        return { value: fn(request, timeoutMs) };
      } catch (e) {
        if (!(e instanceof SourceTimeout)) throw e;
      }
    }
    return { failed: left() <= 0 ? 'DEADLINE' : 'SOURCE_UNAVAILABLE' };
  };

  const hotels = Object.fromEntries(
    hotelIds.map((id) => [id, { state: 'PARTIAL', reasons: ['NOT_READ'] }]),
  );
  const readChunk = (chunk) => {
    let cursor = null;
    for (;;) {
      const r = call(fetchPage, { month, hotelIds: chunk, cursor });
      if (r.failed) {
        for (const id of chunk)
          if (hotels[id].reasons[0] === 'NOT_READ')
            hotels[id] = { state: 'PARTIAL', reasons: [r.failed] };
        return;
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
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  };

  for (let i = 0; i < hotelIds.length; i += limits.maxHotelsPerCall)
    readChunk(hotelIds.slice(i, i + limits.maxHotelsPerCall));

  return { hotels, aggregate: verifyAggregate(), tries, elapsedMs: clock.now() - start };

  function verifyAggregate() {
    const no = (reasons, extra = {}) => ({ consistent: false, asOf: null, reasons, ...extra });
    if (Object.values(hotels).some((h) => h.state !== 'COMPLETE')) return no(['INCOMPLETE_SOURCE']);
    if (hotelIds.length > limits.maxHotelsPerVerify) return no(['SCOPE_TOO_LARGE']);
    for (let round = 0; round < 2; round++) {
      const v = call(verify, { month, hotelIds });
      if (v.failed) return no([v.failed]);
      const changed = hotelIds.filter((id) => v.value.fingerprints[id] !== hotels[id].fingerprint);
      if (changed.length === 0) return { consistent: true, asOf: v.value.verifiedAt, reasons: [] };
      if (round === 1) return no(['CHANGED_DURING_READ'], { changedHotelIds: changed });
      // Re-read only the changed hotels once (whole, one call each batch), then verify again.
      for (let i = 0; i < changed.length; i += limits.maxHotelsPerCall)
        readChunk(changed.slice(i, i + limits.maxHotelsPerCall));
      if (changed.some((id) => hotels[id].state !== 'COMPLETE')) return no(['INCOMPLETE_SOURCE']);
    }
  }
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
    aggregate: read.aggregate.consistent,
  };
}
