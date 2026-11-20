// node --test docs/prototypes/071-margin-batches.test.mjs — doc 071 §3.6 example (batches).
// Fictional data only: 450 made-up hotels, one crate of 40 bottles each; a fake core and clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS,
  SourceTimeout,
  readActivity,
  sourceSummary,
} from './071-margin-batches.mjs';

const MONTH = '2026-11';
const hotelIds = Array.from(
  { length: 450 },
  (_, i) => `hotel-smysleny-${String(i + 1).padStart(3, '0')}`,
);

/** A fake core: `pageRows` circulations per page, `callMs` per call; `tamper` changes the data. */
function fakeCore({ pageRows = 1000, callMs = 1000, tamper = {}, clock }) {
  const calls = [];
  const fetchPage = (req, timeoutMs) => {
    calls.push(req);
    const ms = tamper.slowCall?.(calls.length) ?? callMs;
    clock.advance(Math.min(ms, timeoutMs));
    if (ms > timeoutMs) throw new SourceTimeout('fake timeout');
    const snapshot = tamper.snapshotAt?.(calls.length) ?? 'SNAP-2026-11-30T23:00:00Z';
    const rows = req.hotelIds.flatMap((hotelId) =>
      Array.from({ length: 40 }, (_, b) => ({
        hotelId,
        crateCycleId: `CC-${hotelId}`,
        bottleId: `B${b + 1}`,
        kind: 'REFILL',
        consumed: [],
      })).filter((c) => !(tamper.dropBottle?.hotelId === hotelId && c.bottleId === 'B40')),
    );
    const from = req.cursor ?? 0;
    const to = Math.min(from + pageRows, rows.length);
    const lastIndex = new Map(rows.map((c, i) => [c.hotelId, i]));
    return {
      snapshot,
      hotels:
        from === 0
          ? req.hotelIds.map((hotelId) => ({
              hotelId,
              totals: { dispatches: 1, circulations: 40, returns: 0 },
              dispatches: [
                { crateCycleId: `CC-${hotelId}`, dispatchedOn: '2026-11-05', bottleCount: 40 },
              ],
              returns: [],
            }))
          : [],
      circulations: rows.slice(from, to),
      completedHotelIds: req.hotelIds.filter((h) => {
        const last = lastIndex.get(h);
        return last !== undefined && last < to;
      }),
      nextCursor: to < rows.length ? to : null,
    };
  };
  return { fetchPage, calls };
}
const fakeClock = () => {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test('450 hotels in 3 calls of ≤ 200 hotels, 8 + 8 + 2 pages of ≤ 1000 rows: all complete', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock });
  const read = readActivity(core.fetchPage, { month: MONTH, hotelIds, clock });
  assert.equal(core.calls.length, 18);
  assert.ok(core.calls.every((c) => c.hotelIds.length <= DEFAULT_LIMITS.maxHotelsPerCall));
  // Every page after the first carries the snapshot of the first one.
  assert.ok(core.calls.slice(1).every((c) => c.snapshot === 'SNAP-2026-11-30T23:00:00Z'));
  assert.deepEqual(sourceSummary(read), {
    snapshot: 'SNAP-2026-11-30T23:00:00Z',
    COMPLETE: 450,
    PARTIAL: 0,
    UNRECONCILED: 0,
    total: 450,
  });
  assert.equal(read.hotels[hotelIds[0]].activity.circulations.length, 40);
});

test('the deadline stops the read: what is fully in stays complete, the rest is PARTIAL, never computed', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock });
  const read = readActivity(core.fetchPage, {
    month: MONTH,
    hotelIds,
    clock,
    limits: { ...DEFAULT_LIMITS, deadlineMs: 12_000 },
  });
  // 8 pages of call 1 (hotels 1–200), then 4 pages of call 2 (hotels 201–300) before 12 s.
  assert.equal(core.calls.length, 12);
  assert.deepEqual(sourceSummary(read), {
    snapshot: 'SNAP-2026-11-30T23:00:00Z',
    COMPLETE: 300,
    PARTIAL: 150,
    UNRECONCILED: 0,
    total: 450,
  });
  assert.deepEqual(read.hotels['hotel-smysleny-301'], { state: 'PARTIAL', reasons: ['DEADLINE'] });
  assert.deepEqual(read.hotels['hotel-smysleny-450'], { state: 'PARTIAL', reasons: ['DEADLINE'] });
  assert.equal(read.hotels['hotel-smysleny-301'].activity, undefined);
});

test('a page that times out twice leaves its hotels PARTIAL; the other calls still run', () => {
  const clock = fakeClock();
  // Call 9 and its retry (call 10) are the first page of hotels 201–400: both time out.
  const core = fakeCore({
    clock,
    tamper: { slowCall: (n) => (n === 9 || n === 10 ? 15_000 : undefined) },
  });
  const read = readActivity(core.fetchPage, { month: MONTH, hotelIds, clock });
  assert.equal(read.hotels['hotel-smysleny-201'].state, 'PARTIAL');
  assert.deepEqual(read.hotels['hotel-smysleny-400'].reasons, ['SOURCE_UNAVAILABLE']);
  assert.equal(read.hotels['hotel-smysleny-200'].state, 'COMPLETE');
  assert.equal(read.hotels['hotel-smysleny-401'].state, 'COMPLETE');
  assert.equal(sourceSummary(read).PARTIAL, 200);
});

test('a hotel whose rows do not add up is UNRECONCILED, not computed from 39 bottles', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock, tamper: { dropBottle: { hotelId: 'hotel-smysleny-007' } } });
  const read = readActivity(core.fetchPage, { month: MONTH, hotelIds, clock });
  assert.deepEqual(read.hotels['hotel-smysleny-007'], {
    state: 'UNRECONCILED',
    reasons: ['COUNT_MISMATCH', 'CRATE_COUNT_MISMATCH'],
  });
  assert.equal(sourceSummary(read).COMPLETE, 449);
});

test('pages of two different moments are never combined: the whole read is UNRECONCILED', () => {
  const clock = fakeClock();
  const core = fakeCore({
    clock,
    tamper: { snapshotAt: (n) => (n >= 5 ? 'SNAP-2026-11-30T23:05:00Z' : undefined) },
  });
  const read = readActivity(core.fetchPage, { month: MONTH, hotelIds, clock });
  assert.equal(core.calls.length, 5);
  assert.deepEqual(sourceSummary(read), {
    snapshot: 'SNAP-2026-11-30T23:00:00Z',
    COMPLETE: 0,
    PARTIAL: 0,
    UNRECONCILED: 450,
    total: 450,
  });
  assert.deepEqual(read.hotels['hotel-smysleny-001'].reasons, ['SNAPSHOT_CHANGED']);
});
