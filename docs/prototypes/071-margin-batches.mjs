// Doc 071 §3.6 — reading a large volume of core activity in batches, with time limits, and how a
// partial or unreconciled source is marked. PROPOSAL: an isolated model over a fake core; no
// database, no network, nothing imported by the application. All limits are proposals.
//
// The core contract (doc 071 §3.1) is paged:
//   request   { month, hotelIds (≤ maxHotelsPerCall), cursor|null, snapshot|null }
//   response  { snapshot,                      // the core's read watermark, fixed by the first page
//               hotels: [{ hotelId, totals: { dispatches, circulations, returns },
//                          dispatches: [{ crateCycleId, dispatchedOn, bottleCount }],
//                          returns: [...] }],   // headers: on the first page of each call
//               circulations: [...],            // paged, ordered by hotel
//               completedHotelIds: [...],       // hotels whose rows are now all delivered
//               nextCursor|null }
// The core reads only rows recorded ≤ snapshot (consumption, crate events and return lines are
// append-only), so every page of every call describes the same moment.

export const DEFAULT_LIMITS = Object.freeze({
  maxHotelsPerCall: 200, // like the commission contract
  callTimeoutMs: 10_000, // one page
  deadlineMs: 60_000, // the whole overview build
  retriesPerPage: 1, // a read is idempotent; one retry, then the hotels stay PARTIAL
});

export class SourceTimeout extends Error {}

/**
 * Reads the activity of `hotelIds` for `month`. Returns per hotel:
 *   COMPLETE      every row delivered and reconciled: the margin may be computed
 *   PARTIAL       not every row arrived (deadline, timeout, core error): reasons NOT_READ,
 *                 DEADLINE, SOURCE_UNAVAILABLE — never computed from what did arrive
 *   UNRECONCILED  everything arrived but does not add up (COUNT_MISMATCH, CRATE_COUNT_MISMATCH,
 *                 FOREIGN_CRATE, SNAPSHOT_CHANGED) — never computed, a data question for the admin
 * `clock` is injected ({ now(): ms }), `fetchPage(request, timeoutMs)` may throw SourceTimeout.
 */
export function readActivity(fetchPage, { month, hotelIds, clock, limits = DEFAULT_LIMITS }) {
  const start = clock.now();
  const state = new Map(hotelIds.map((id) => [id, { header: null, rows: [], done: false }]));
  const reasons = new Map(hotelIds.map((id) => [id, []]));
  let snapshot = null;
  let snapshotChanged = false;

  const chunks = [];
  for (let i = 0; i < hotelIds.length; i += limits.maxHotelsPerCall)
    chunks.push(hotelIds.slice(i, i + limits.maxHotelsPerCall));

  outer: for (const chunk of chunks) {
    let cursor = null;
    for (;;) {
      if (clock.now() - start >= limits.deadlineMs) {
        for (const id of chunk) if (!state.get(id).done) reasons.get(id).push('DEADLINE');
        continue outer;
      }
      let page = null;
      for (let attempt = 0; attempt <= limits.retriesPerPage && !page; attempt++) {
        try {
          page = fetchPage({ month, hotelIds: chunk, cursor, snapshot }, limits.callTimeoutMs);
        } catch (e) {
          if (!(e instanceof SourceTimeout)) throw e;
        }
      }
      if (!page) {
        for (const id of chunk) if (!state.get(id).done) reasons.get(id).push('SOURCE_UNAVAILABLE');
        continue outer;
      }
      if (snapshot === null) snapshot = page.snapshot;
      else if (page.snapshot !== snapshot) {
        snapshotChanged = true;
        break outer;
      }
      for (const h of page.hotels) state.get(h.hotelId).header = h;
      for (const c of page.circulations) state.get(c.hotelId).rows.push(c);
      for (const id of page.completedHotelIds) state.get(id).done = true;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  const result = {};
  for (const id of hotelIds) {
    const s = state.get(id);
    const r = reasons.get(id);
    if (snapshotChanged) {
      // Pages of two different moments are never combined: the whole read is repeated.
      result[id] = { state: 'UNRECONCILED', reasons: ['SNAPSHOT_CHANGED'] };
      continue;
    }
    if (!s.done || !s.header) {
      result[id] = { state: 'PARTIAL', reasons: r.length ? r : ['NOT_READ'] };
      continue;
    }
    const mismatch = reconcile(s.header, s.rows);
    result[id] = mismatch.length
      ? { state: 'UNRECONCILED', reasons: mismatch }
      : {
          state: 'COMPLETE',
          reasons: [],
          activity: {
            dispatches: s.header.dispatches,
            returns: s.header.returns,
            circulations: s.rows,
          },
        };
  }
  return { snapshot, elapsedMs: clock.now() - start, hotels: result };
}

/** The core's own totals must match what arrived, crate by crate. */
function reconcile(header, rows) {
  const out = [];
  if (
    header.dispatches.length !== header.totals.dispatches ||
    header.returns.length !== header.totals.returns ||
    rows.length !== header.totals.circulations
  )
    out.push('COUNT_MISMATCH');
  const perCrate = new Map(header.dispatches.map((d) => [d.crateCycleId, 0]));
  for (const c of rows) {
    if (!perCrate.has(c.crateCycleId)) {
      out.push('FOREIGN_CRATE');
      continue;
    }
    perCrate.set(c.crateCycleId, perCrate.get(c.crateCycleId) + 1);
  }
  for (const d of header.dispatches)
    if (perCrate.get(d.crateCycleId) !== d.bottleCount) out.push('CRATE_COUNT_MISMATCH');
  return [...new Set(out)];
}

/** Summary line for the admin (doc 071 §3.6): how much of the source is in, never a margin. */
export function sourceSummary(read) {
  const counts = { COMPLETE: 0, PARTIAL: 0, UNRECONCILED: 0 };
  for (const h of Object.values(read.hotels)) counts[h.state]++;
  return { snapshot: read.snapshot, ...counts, total: Object.keys(read.hotels).length };
}
