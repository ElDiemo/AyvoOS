// node --test docs/prototypes/071-margin-batches.test.mjs — doc 071 §3.6 / ADR 0049 §4 example.
// Fictional data only: 450 made-up hotels, one crate of 40 bottles each; a fake core and clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS,
  SourceTimeout,
  fingerprintOf,
  readActivity,
  sourceSummary,
  takeSnapshot,
  visibleInSnapshot,
} from './071-margin-batches.mjs';

const MONTH = '2026-11';
const hotelIds = Array.from(
  { length: 450 },
  (_, i) => `hotel-smysleny-${String(i + 1).padStart(3, '0')}`,
);

const fakeClock = () => {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
};

/** The core's committed state: per hotel its crates (each a refill of 40 bottles). */
function coreState() {
  const state = new Map();
  for (const hotelId of hotelIds) state.set(hotelId, { crates: [`CC-${hotelId}-1`] });
  return state;
}
function hotelRows(hotelId, s) {
  const dispatches = s.crates.map((crateCycleId) => ({
    crateCycleId,
    hotelId,
    dispatchedOn: '2026-11-05',
    bottleCount: 40,
    status: 'DISPATCHED',
  }));
  const circulations = s.crates.flatMap((crateCycleId) =>
    Array.from({ length: 40 }, (_, b) => ({
      crateCycleId,
      bottleId: `B${b + 1}`,
      kind: 'REFILL',
      consumed: [
        {
          movementId: `MV-${crateCycleId}-${b + 1}`,
          item: 'LIQ_HS',
          itemKind: 'LIQUID',
          unit: 'l',
          qty: '0.330',
          on: '2026-11-04',
        },
      ],
    })),
  );
  const h = {
    hotelId,
    totals: { dispatches: dispatches.length, circulations: circulations.length, returns: 0 },
    dispatches,
    returns: [],
    circulations,
  };
  h.fingerprint = fingerprintOf(h); // the core's fingerprint of what it read
  return h;
}

/**
 * A fake core: 1 s per call unless `slow(n)` says otherwise; `afterCall(n, state)` lets a late
 * transaction commit between calls; `deliver(h)` may alter what is sent after the fingerprint
 * (a faulty core or transfer). Each call reads its hotels whole, in one moment (readAt).
 */
function fakeCore({ clock, slow = () => undefined, afterCall = () => {}, deliver = (h) => h }) {
  const state = coreState();
  let n = 0;
  const fetchPage = (req, timeoutMs) => {
    n++;
    const took = slow(n) ?? 1000;
    clock.advance(Math.min(took, timeoutMs));
    if (took > timeoutMs) {
      afterCall(n, state);
      throw new SourceTimeout('fake timeout');
    }
    const page = [];
    let rows = 0;
    let i = req.cursor ?? 0;
    for (; i < req.hotelIds.length; i++) {
      const h = hotelRows(req.hotelIds[i], state.get(req.hotelIds[i]));
      if (page.length > 0 && rows + h.circulations.length > DEFAULT_LIMITS.maxRowsPerPage) break;
      page.push(deliver(h));
      rows += h.circulations.length;
    }
    const value = {
      readAt: clock.now(),
      hotels: page,
      nextCursor: i < req.hotelIds.length ? i : null,
    };
    afterCall(n, state);
    return value;
  };
  return { fetchPage, state, calls: () => n };
}

const read = (core, clock, limits) =>
  readActivity(core.fetchPage, { month: MONTH, hotelIds, clock, limits });

test('450 hotels: 18 pages of whole hotels, each valid as of its readAt; no sum over hotels in v1', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock });
  const r = read(core, clock);
  assert.equal(core.calls(), 18);
  assert.ok(r.tries.every((t) => t.request.hotelIds.length <= 200));
  assert.deepEqual(sourceSummary(r), { COMPLETE: 450, PARTIAL: 0, UNRECONCILED: 0, total: 450 });
  assert.equal(r.hotels['hotel-smysleny-001'].readAt, 1000);
  assert.equal(r.hotels['hotel-smysleny-450'].readAt, 18_000);
  assert.deepEqual(r.aggregate, { offered: false, reason: 'NOT_IN_V1' });
});

test('the deadline: what is in stays valid per hotel, the rest is PARTIAL', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock });
  const r = read(core, clock, { ...DEFAULT_LIMITS, deadlineMs: 12_000 });
  assert.equal(core.calls(), 12); // no 13th try: the budget is 0
  assert.equal(sourceSummary(r).COMPLETE, 300);
  assert.deepEqual(r.hotels['hotel-smysleny-301'], { state: 'PARTIAL', reasons: ['DEADLINE'] });
});

test('a hard total deadline before every try: a try gets min(10 s, remaining), no try after it', () => {
  const clock = fakeClock();
  // Call 9 (first page of hotels 201–400) and its retry would take 15 s; 8 s used, 12 s left of 20 s.
  const core = fakeCore({ clock, slow: (n) => (n === 9 || n === 10 ? 15_000 : undefined) });
  const r = read(core, clock, { ...DEFAULT_LIMITS, deadlineMs: 20_000 });
  // Try 9: min(10 s per call, 12 s left) = 10 s; its retry gets only the last 2 s; then nothing.
  assert.equal(core.calls(), 10);
  assert.deepEqual(
    r.tries.slice(8).map((t) => t.timeoutMs),
    [10_000, 2_000],
  );
  assert.deepEqual(r.hotels['hotel-smysleny-201'].reasons, ['DEADLINE']);
  assert.deepEqual(r.hotels['hotel-smysleny-450'].reasons, ['DEADLINE']); // never tried
  assert.equal(r.elapsedMs, 20_000);
});

test('a page that times out twice within the budget: its hotels PARTIAL, the others still read', () => {
  const clock = fakeClock();
  const core = fakeCore({ clock, slow: (n) => (n === 9 || n === 10 ? 15_000 : undefined) });
  const r = read(core, clock);
  assert.deepEqual(r.hotels['hotel-smysleny-400'], {
    state: 'PARTIAL',
    reasons: ['SOURCE_UNAVAILABLE'],
  });
  assert.equal(r.hotels['hotel-smysleny-401'].state, 'COMPLETE');
  assert.equal(sourceSummary(r).PARTIAL, 200);
});

test('a hotel whose rows do not add up is UNRECONCILED, not computed from 39 bottles', () => {
  const clock = fakeClock();
  const core = fakeCore({
    clock,
    deliver: (h) =>
      h.hotelId === 'hotel-smysleny-007' ? { ...h, circulations: h.circulations.slice(0, -1) } : h,
  });
  const r = read(core, clock);
  assert.deepEqual(r.hotels['hotel-smysleny-007'], {
    state: 'UNRECONCILED',
    reasons: ['COUNT_MISMATCH', 'CRATE_COUNT_MISMATCH', 'FINGERPRINT_MISMATCH'],
  });
});

test('the same keys and counts with a changed money value: FINGERPRINT_MISMATCH, never computed', () => {
  const at = (path, value) => (h) => {
    const copy = structuredClone(h);
    path(copy, value);
    return copy;
  };
  const changes = {
    quantity: at((h) => (h.circulations[3].consumed[0].qty = '0.300')),
    unit: at((h) => (h.circulations[3].consumed[0].unit = 'ml')),
    item: at((h) => (h.circulations[3].consumed[0].item = 'LIQ_SG')),
    'consumption day': at((h) => (h.circulations[3].consumed[0].on = '2026-10-31')),
    'circulation kind': at((h) => (h.circulations[3].kind = 'FIRST_USE')),
    'dispatch day': at((h) => (h.dispatches[0].dispatchedOn = '2026-12-01')),
    'dispatch hotel': at((h) => (h.dispatches[0].hotelId = 'hotel-smysleny-008')),
    'crate state': at((h) => (h.dispatches[0].status = 'CANCELLED')),
  };
  // What a keys-and-counts fingerprint would have said: unchanged.
  const keysOnly = (h) =>
    [
      ...h.dispatches.map((d) => `D:${d.crateCycleId}:${d.bottleCount}`),
      ...h.circulations.map((c) => `C:${c.crateCycleId}:${c.bottleId}`),
    ]
      .sort()
      .join('|');
  for (const [what, change] of Object.entries(changes)) {
    const clock = fakeClock();
    const core = fakeCore({
      clock,
      deliver: (h) => (h.hotelId === 'hotel-smysleny-007' ? change(h) : h),
    });
    const r = read(core, clock);
    assert.deepEqual(
      r.hotels['hotel-smysleny-007'],
      { state: 'UNRECONCILED', reasons: ['FINGERPRINT_MISMATCH'] },
      what,
    );
    const original = hotelRows('hotel-smysleny-007', { crates: ['CC-hotel-smysleny-007-1'] });
    assert.equal(keysOnly(change(original)), keysOnly(original), what);
    assert.equal(sourceSummary(r).COMPLETE, 449, what);
  }
});

test('a late commit between two calls: each hotel consistent as of its own readAt — which is why there is no sum', () => {
  const clock = fakeClock();
  // One late transaction adds a crate to hotel 007 (read in call 1) and hotel 030 (call 2) and
  // commits right after call 1.
  const core = fakeCore({
    clock,
    afterCall: (n, state) => {
      if (n === 1)
        for (const id of ['hotel-smysleny-007', 'hotel-smysleny-030'])
          state.get(id).crates.push(`CC-${id}-late`);
    },
  });
  const r = read(core, clock);
  const h7 = r.hotels['hotel-smysleny-007'];
  const h30 = r.hotels['hotel-smysleny-030'];
  // 007: the state before the commit, whole (never half of the late transaction).
  assert.equal(h7.state, 'COMPLETE');
  assert.equal(h7.readAt, 1000);
  assert.equal(h7.activity.circulations.length, 40);
  // 030: the state after it, whole.
  assert.equal(h30.state, 'COMPLETE');
  assert.equal(h30.readAt, 2000);
  assert.equal(h30.activity.circulations.length, 80);
  // A sum of 007 + 030 would mix two moments: v1 offers none.
  assert.equal(r.aggregate.offered, false);
});

// --- Why a watermark or a sequence cursor is not enough, and Variant S ---------------------------

function fakeDb() {
  const db = { nextXid: 100, seq: 0, transactions: [], rows: [] };
  db.begin = (t) => {
    const tx = { xid: db.nextXid++, startedAt: t, state: 'IN_PROGRESS' };
    db.transactions.push(tx);
    return tx;
  };
  // now() of a row is its transaction's start; the sequence is taken at the insert.
  db.insert = (tx, key) =>
    db.rows.push({ key, xid: tx.xid, recordedAt: tx.startedAt, seq: ++db.seq });
  db.commit = (tx) => (tx.state = 'COMMITTED');
  db.committed = (row) => db.transactions.find((t) => t.xid === row.xid).state === 'COMMITTED';
  return db;
}

test('the late commit: a time watermark shows half a transaction, a seq cursor loses a row, a snapshot does neither', () => {
  const db = fakeDb();
  const t0 = db.begin(0);
  db.insert(t0, 'r1');
  db.insert(t0, 'r3');
  db.commit(t0);
  const late = db.begin(1); // starts before the first page …
  db.insert(late, 'r2');
  db.insert(late, 'r4');
  const other = db.begin(1);
  db.insert(other, 'r5');
  db.commit(other);
  const byKey = (a, b) => a.key.localeCompare(b.key);
  const page = (filter, after, limit = 2) =>
    db.rows
      .filter((r) => db.committed(r) && filter(r) && r.key > after)
      .sort(byKey)
      .slice(0, limit)
      .map((r) => r.key);

  // Page 1 at t = 2 with a watermark t = 2 and a snapshot taken then.
  const watermark = 2;
  const snap = takeSnapshot(db);
  const wm1 = page((r) => r.recordedAt <= watermark, '');
  const seq1 = db.rows
    .filter((r) => db.committed(r))
    .sort((a, b) => a.seq - b.seq)
    .slice(0, 3);
  const snap1 = page((r) => visibleInSnapshot(r.xid, snap), '');
  db.commit(late); // … and commits between page 1 and page 2

  // Watermark: page 2 suddenly sees r4 (recorded at 1 ≤ 2) but r2 was before the cursor.
  const wm2 = page((r) => r.recordedAt <= watermark, wm1.at(-1), 10);
  assert.deepEqual([...wm1, ...wm2], ['r1', 'r3', 'r4', 'r5']); // r4 without r2: never a real state
  // Seq keyset: page 1 read seq 1, 2, 5 (3 and 4 were not committed); page 2 continues after 5.
  const lastSeq = seq1.at(-1).seq;
  const seq2 = db.rows.filter((r) => db.committed(r) && r.seq > lastSeq);
  assert.deepEqual(
    seq1.map((r) => r.key),
    ['r1', 'r3', 'r5'],
  );
  assert.deepEqual(seq2, []); // r2 and r4 (seq 3, 4) are lost for ever
  // Variant S: page 2 with the same snapshot sees exactly the state of page 1's moment.
  const snap2 = page((r) => visibleInSnapshot(r.xid, snap), snap1.at(-1), 10);
  assert.deepEqual([...snap1, ...snap2], ['r1', 'r3', 'r5']);
  assert.deepEqual(snap, { xmin: 101, xmax: 103, xip: [101] });
});
