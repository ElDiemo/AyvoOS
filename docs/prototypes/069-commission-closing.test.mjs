// node --test docs/prototypes/069-commission-closing.test.mjs — doc 069 §8 scenarios.
// Synthetic data only (fictional hotels, invoices and people).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_BATCH,
  ClosingError,
  approve,
  approvedVsComputed,
  cents,
  commitApproval,
  commission,
  createStore,
  mine,
  payoutPlan,
  prepareApproval,
  preview,
} from './069-commission-closing.mjs';

const A = { salespersonId: 'sp-a', displayName: 'Alena Fiktivní' };
const B = { salespersonId: 'sp-b', displayName: 'Bohdan Smyšlený' };
const plan = (id, v, i, n, m) => ({
  bindingId: id,
  termsVersion: v,
  initialRate: i,
  initialMonths: n,
  maintenanceRate: m,
});

/** A Finance invoice line as the real rows (doc 069 §2). Payment data are present and ignored. */
let seq = 0;
function line(over) {
  seq += 1;
  return {
    invoiceId: over.invoiceId ?? `inv-${seq}`,
    invoiceNumber: over.invoiceNumber ?? `TEST-2027-${String(seq).padStart(4, '0')}`,
    kind: 'TEST',
    currency: 'CZK',
    lineNo: 1,
    periodMonth: '2027-07',
    hotelId: 'h-1',
    hotelCode: 'HT-000001',
    billedRooms: 40,
    unitPrice: '120.50',
    amount: '4820.00',
    issuedAt: '2027-07-01T08:00:00Z',
    cancelledAt: null,
    payment: { paid: false }, // never an input
    ...over,
  };
}

/** The core contract (doc 069 §4) from a table hotelId → attribution, per month. */
function contractOf(table, calls = []) {
  return (month, hotelIds) => {
    calls.push({ month, hotelIds });
    const hotels = hotelIds.map((hotelId) => ({
      hotelId,
      attribution: table(hotelId, month) ?? null,
    }));
    return { month, fingerprint: JSON.stringify(hotels), hotels };
  };
}
const attr = (recipient, binding, commissionStart = '2027-06', revision = 1) => ({
  revision,
  effectiveFrom: commissionStart,
  commissionStart,
  recipient,
  binding,
});

const deps = (lines, table, store = createStore(), today = '2027-08-01') => ({
  lines,
  contract: contractOf(table),
  store,
  today,
});

function approveAll(d, month, mode = 'TEST') {
  const p = preview({ ...d, month, mode });
  return p.statements.map((s) =>
    approve(
      {
        requestId: `rq-${month}-${s.salespersonId}`,
        month,
        salespersonId: s.salespersonId,
        currency: s.currency,
        mode,
        fingerprint: s.fingerprint,
        actorId: 'admin',
      },
      d,
    ),
  );
}

test('money: per line half-up to 0.01, exact', () => {
  assert.equal(commission(cents('4820.00'), '20.00'), cents('964.00'));
  assert.equal(commission(cents('0.05'), '10.00'), 1); // 0.005 → 0.01
  assert.equal(commission(cents('0.04'), '10.00'), 0);
  assert.throws(() => cents('1.005'), /AMOUNT_INVALID/);
});

test('billed period, never the payment: a paid and an unpaid line count the same', () => {
  const table = () => attr(A, plan('b1', 1, '20.00', 24, '5.00'));
  const unpaid = preview({
    ...deps([line({ hotelId: 'h-1' })], table),
    month: '2027-07',
    mode: 'TEST',
  });
  const paid = preview({
    ...deps([line({ hotelId: 'h-1', payment: { paid: true, on: '2027-07-20' } })], table),
    month: '2027-07',
    mode: 'TEST',
  });
  assert.equal(unpaid.statements[0].total, cents('964.00'));
  assert.equal(paid.statements[0].total, unpaid.statements[0].total);
  // An invoice of another billed period is not in July.
  const aug = preview({
    ...deps([line({ periodMonth: '2027-08' })], table),
    month: '2027-07',
    mode: 'TEST',
  });
  assert.equal(aug.statements.length, 0);
});

test('a month is approved only once it is closed (from the 1st of M+1)', () => {
  const d = deps(
    [line({})],
    () => attr(A, plan('b1', 1, '20.00', 24, '5.00')),
    createStore(),
    '2027-07-31',
  );
  assert.throws(() => preview({ ...d, month: '2027-07', mode: 'TEST' }), /MONTH_NOT_CLOSED/);
});

test('summary invoice with two hotels → two salespeople, one statement each', () => {
  const lines = [
    line({ invoiceId: 'inv-sum', lineNo: 1, hotelId: 'h-1', hotelCode: 'HT-000001' }),
    line({
      invoiceId: 'inv-sum',
      lineNo: 2,
      hotelId: 'h-2',
      hotelCode: 'HT-000002',
      amount: '3000.00',
    }),
  ];
  const table = (h) =>
    h === 'h-1'
      ? attr(A, plan('b1', 1, '20.00', 24, '5.00'))
      : attr(B, plan('b2', 1, '10.00', 36, '3.00'));
  const p = preview({ ...deps(lines, table), month: '2027-07', mode: 'TEST' });
  const by = Object.fromEntries(p.statements.map((s) => [s.salespersonId, s.total]));
  assert.deepEqual(by, { 'sp-a': cents('964.00'), 'sp-b': cents('300.00') });
});

test('rate boundary k = 24 / 25 (two hotels of one salesperson in one month)', () => {
  const lines = [
    line({ hotelId: 'h-24', hotelCode: 'HT-24' }),
    line({ hotelId: 'h-25', hotelCode: 'HT-25' }),
  ];
  const table = (h) =>
    attr(A, plan('b', 1, '20.00', 24, '5.00'), h === 'h-24' ? '2025-08' : '2025-07');
  const [s] = preview({ ...deps(lines, table), month: '2027-07', mode: 'TEST' }).statements;
  assert.deepEqual(
    s.items.map((i) => [i.hotelCode, i.k, i.rate]),
    [
      ['HT-24', 24, '20.00'],
      ['HT-25', 25, '5.00'],
    ],
  );
});

test('missing attribution, missing terms, Firemní hotel, before the start', () => {
  const lines = [
    line({ hotelId: 'h-none', hotelCode: 'HT-NONE' }),
    line({ hotelId: 'h-noterms', hotelCode: 'HT-NOTERMS' }),
    line({ hotelId: 'h-house', hotelCode: 'HT-HOUSE' }),
    line({ hotelId: 'h-early', hotelCode: 'HT-EARLY' }),
    line({ hotelId: 'h-ok', hotelCode: 'HT-OK' }),
  ];
  const table = (h) =>
    ({
      'h-noterms': attr(A, null),
      'h-house': attr(null, null),
      'h-early': attr(B, plan('b', 1, '10.00', 36, '3.00'), '2027-09'),
      'h-ok': attr(B, plan('b', 1, '10.00', 36, '3.00')),
    })[h];
  const d = deps(lines, table);
  const p = preview({ ...d, month: '2027-07', mode: 'TEST' });
  assert.deepEqual(
    p.unassigned.map((u) => u.hotelCode),
    ['HT-NONE'],
  );
  const a = p.statements.find((s) => s.salespersonId === 'sp-a');
  const b = p.statements.find((s) => s.salespersonId === 'sp-b');
  assert.deepEqual(
    a.flags.map((f) => f.code),
    ['TERMS_MISSING'],
  );
  assert.deepEqual(
    b.flags.map((f) => f.code),
    ['BEFORE_COMMISSION_START'],
  );
  assert.equal(
    p.statements.some((s) => s.items.some((i) => i.hotelCode === 'HT-HOUSE')),
    false,
  );
  // A flag blocks only its own salesperson.
  const req = (s) => ({
    requestId: `rq-${s.salespersonId}`,
    month: '2027-07',
    salespersonId: s.salespersonId,
    currency: 'CZK',
    mode: 'TEST',
    fingerprint: s.fingerprint,
    actorId: 'admin',
  });
  assert.throws(() => approve(req(a), d), /STATEMENT_FLAGGED/);
  assert.throws(() => approve(req(b), d), /STATEMENT_FLAGGED/);
  assert.equal(d.store.statements.length, 0);
});

test('double closing, concurrent approval and a replay after a lost answer', () => {
  const d = deps([line({})], () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  const [s] = preview({ ...d, month: '2027-07', mode: 'TEST' }).statements;
  const req = (requestId) => ({
    requestId,
    month: '2027-07',
    salespersonId: 'sp-a',
    currency: 'CZK',
    mode: 'TEST',
    fingerprint: s.fingerprint,
    actorId: 'admin',
  });
  const first = approve(req('rq-1'), d);
  assert.deepEqual(approve(req('rq-1'), d), first); // lost answer → the same result
  assert.throws(() => approve(req('rq-2'), d), /ALREADY_APPROVED/); // the second admin
  assert.throws(() => approve({ ...req('rq-1'), fingerprint: 'other' }, d), /IDEMPOTENCY_CONFLICT/);
  assert.equal(d.store.statements.length, 1);
  assert.equal(d.store.items.length, 1);
});

test('a changed source refuses the approval (STATEMENT_STALE)', () => {
  let rate = '20.00';
  const d = deps([line({})], () => attr(A, plan('b1', 1, rate, 24, '5.00')));
  const [s] = preview({ ...d, month: '2027-07', mode: 'TEST' }).statements;
  rate = '30.00'; // e.g. a corrected attribution in the core meanwhile
  assert.throws(
    () =>
      approve(
        {
          requestId: 'rq',
          month: '2027-07',
          salespersonId: 'sp-a',
          currency: 'CZK',
          mode: 'TEST',
          fingerprint: s.fingerprint,
          actorId: 'admin',
        },
        d,
      ),
    /STATEMENT_STALE/,
  );
  assert.equal(d.store.statements.length, 0);
});

test('cancelled before approval: excluded; after approval: a correction in the next statement', () => {
  const before = deps([line({ cancelledAt: '2027-07-20T10:00:00Z' })], () =>
    attr(A, plan('b1', 1, '20.00', 24, '5.00')),
  );
  assert.equal(preview({ ...before, month: '2027-07', mode: 'TEST' }).statements.length, 0);

  const july = line({ invoiceId: 'inv-j' });
  const d = deps([july], () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  approveAll(d, '2027-07');
  july.cancelledAt = '2027-08-05T09:00:00Z';
  d.today = '2027-09-01';
  const [aug] = preview({ ...d, month: '2027-08', mode: 'TEST' }).statements;
  assert.deepEqual(
    aug.items.map((i) => [i.kind, i.serviceMonth, i.rate, i.amount]),
    [['CORRECTION', '2027-07', '20.00', -cents('964.00')]],
  );
  // The July statement itself never changes.
  assert.equal(d.store.statements[0].total, cents('964.00'));
  assert.throws(() => {
    d.store.statements[0].total = 0;
  }, TypeError);
});

test('an invoice for July issued after July was approved → August statement, July rate', () => {
  const lines = [line({ hotelId: 'h-1' })];
  const d = deps(lines, (h, m) => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  approveAll(d, '2027-07');
  lines.push(line({ hotelId: 'h-1', invoiceId: 'inv-late', issuedAt: '2027-08-12T09:00:00Z' }));
  d.today = '2027-09-01';
  const [aug] = preview({ ...d, month: '2027-08', mode: 'TEST' }).statements;
  assert.deepEqual(
    aug.items.map((i) => [i.kind, i.invoiceId, i.serviceMonth, i.k]),
    [['REGULAR', 'inv-late', '2027-07', 2]],
  );
});

test('one source line → at most one regular item across closings (I1)', () => {
  const lines = [line({ invoiceId: 'inv-1' })];
  const d = deps(lines, () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  approveAll(d, '2027-07');
  d.today = '2027-09-01';
  assert.equal(preview({ ...d, month: '2027-08', mode: 'TEST' }).statements.length, 0);
});

test('an approved amount is never changed silently; a recomputation shows a difference', () => {
  const d = deps([line({})], () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  const [r] = approveAll(d, '2027-07');
  assert.equal(r.total, '964.00');
  assert.deepEqual(approvedVsComputed(d.store, r.id, cents('1000.00')), {
    approved: '964.00',
    computed: '1000.00',
    difference: '36.00',
  });
  assert.equal(d.store.statements[0].total, cents('964.00'));
});

test('the core contract is down → nothing computed, nothing written', () => {
  const d = {
    lines: [line({})],
    store: createStore(),
    today: '2027-08-01',
    contract: () => {
      throw new ClosingError('CORE_UNAVAILABLE', 503);
    },
  };
  assert.throws(
    () => preview({ ...d, month: '2027-07', mode: 'TEST' }),
    (e) => e.status === 503,
  );
  assert.throws(
    () =>
      approve(
        {
          requestId: 'rq',
          month: '2027-07',
          salespersonId: 'sp-a',
          currency: 'CZK',
          mode: 'TEST',
          fingerprint: 'x',
          actorId: 'admin',
        },
        d,
      ),
    (e) => e.status === 503,
  );
  assert.equal(d.store.statements.length + d.store.items.length + d.store.operations.size, 0);
});

test('TEST invoices never enter a LIVE statement', () => {
  const d = deps([line({})], () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  assert.equal(preview({ ...d, month: '2027-07', mode: 'LIVE' }).statements.length, 0);
});

test('a salesperson sees only their own state and one amount, never invoice data', () => {
  const lines = [line({ hotelId: 'h-1' }), line({ hotelId: 'h-2', hotelCode: 'HT-000002' })];
  const table = (h) =>
    h === 'h-1'
      ? attr(A, plan('b1', 1, '20.00', 24, '5.00'))
      : attr(B, plan('b2', 1, '10.00', 36, '3.00'));
  const d = deps(lines, table);
  assert.deepEqual(mine(d.store, 'sp-a', '2027-07'), { month: '2027-07', state: 'PROCESSING' });
  approveAll(d, '2027-07');
  const a = mine(d.store, 'sp-a', '2027-07');
  assert.deepEqual(a, {
    month: '2027-07',
    state: 'APPROVED',
    amountToInvoice: '964.00',
    currency: 'CZK',
  });
  assert.equal(JSON.stringify(a).includes('TEST-2027'), false);
  assert.equal(mine(d.store, 'sp-b', '2027-07').amountToInvoice, '482.00');
});

test('payout plan: invoice by the 10th → the 15th; later → the next run', () => {
  assert.equal(payoutPlan('2027-07', '2027-08-10'), '2027-08-15');
  assert.equal(payoutPlan('2027-07', '2027-08-11'), '2027-09-15');
  assert.equal(payoutPlan('2027-12', '2028-01-09'), '2028-01-15');
});

test('payout plan from the actual receipt: never before the invoice, also months late and across a year', () => {
  // The re-review example: July, received 18. 11. → 15. 12. (was 15. 9., before the receipt).
  assert.equal(payoutPlan('2026-07', '2026-11-18'), '2026-12-15');
  // Cut-off 10th / 11th in a later month.
  assert.equal(payoutPlan('2026-07', '2026-11-10'), '2026-11-15');
  assert.equal(payoutPlan('2026-07', '2026-11-11'), '2026-12-15');
  // Several months late, across the year end.
  assert.equal(payoutPlan('2026-07', '2027-02-03'), '2027-02-15');
  assert.equal(payoutPlan('2026-11', '2026-12-31'), '2027-01-15');
  assert.equal(payoutPlan('2026-12', '2027-01-10'), '2027-01-15');
  assert.equal(payoutPlan('2026-12', '2027-01-11'), '2027-02-15');
  // Received early (before M+1, e.g. right after the approval on the 1st) → still the 15th of M+1.
  assert.equal(payoutPlan('2026-07', '2026-08-01'), '2026-08-15');
  // The plan is never before the receipt.
  for (const [m, r] of [
    ['2026-07', '2026-11-18'],
    ['2026-07', '2027-03-10'],
    ['2026-12', '2027-12-11'],
  ])
    assert.ok(payoutPlan(m, r) > r);
});

test('core contract: 201 hotels of one month in batches of 200; a failed second batch gives no partial statement', () => {
  const lines = Array.from({ length: 201 }, (_, n) =>
    line({ hotelId: `h-${String(n).padStart(3, '0')}`, hotelCode: `HT-${n}`, amount: '100.00' }),
  );
  const calls = [];
  let failSecond = false;
  const strict = contractOf(() => attr(A, plan('b1', 1, '20.00', 24, '5.00')), calls);
  const contract = (month, ids) => {
    if (ids.length < 1 || ids.length > CONTRACT_BATCH) throw new ClosingError('BATCH_INVALID', 400);
    if (failSecond && calls.length === 1) throw new ClosingError('CORE_UNAVAILABLE', 503);
    return strict(month, ids);
  };
  const d = { ...deps(lines, null), contract };
  const [s] = preview({ ...d, month: '2027-07', mode: 'TEST' }).statements;
  assert.deepEqual(
    calls.map((c) => c.hotelIds.length),
    [200, 1],
  );
  assert.equal(new Set(calls.flatMap((c) => c.hotelIds)).size, 201);
  assert.deepEqual([s.items.length, s.total], [201, 201 * cents('20.00')]);

  calls.length = 0;
  failSecond = true;
  assert.throws(
    () => preview({ ...d, month: '2027-07', mode: 'TEST' }),
    (e) => e.status === 503,
  );
  calls.length = 0;
  assert.throws(
    () => approve(reqOf({ ...s, periodMonth: '2027-07' }, 'rq-201'), d),
    (e) => e.status === 503,
  );
  assert.equal(d.store.statements.length + d.store.items.length + d.store.operations.size, 0);
  // With the core back, the same fingerprint the admin saw is approved in full.
  failSecond = false;
  calls.length = 0;
  assert.equal(approve(reqOf(s, 'rq-201'), d).total, '4020.00');
  assert.equal(d.store.items.length, 201);
});

// --- Codex re-review of #195 5cad285 ------------------------------------------------------------

const reqOf = (s, requestId, actorId = 'admin') => ({
  requestId,
  month: s.periodMonth,
  salespersonId: s.salespersonId,
  currency: s.currency,
  mode: s.mode,
  fingerprint: s.fingerprint,
  actorId,
});
const stOf = (d, month, sp) =>
  preview({ ...d, month, mode: 'TEST' }).statements.find((s) => s.salespersonId === sp);

test('R1 storno after approval: only the nearest admissible month, never an earlier open one; a negative result is carried, not invoiced', () => {
  const july = line({ invoiceId: 'inv-j' });
  const sep = line({ invoiceId: 'inv-s', periodMonth: '2027-09', amount: '6000.00' });
  const d = deps([july, sep], () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  approveAll(d, '2027-07');
  july.cancelledAt = '2027-08-05T09:00:00Z';
  d.today = '2027-10-01';

  // An earlier month never takes the correction (was: any previewed month did).
  assert.equal(preview({ ...d, month: '2027-06', mode: 'TEST' }).statements.length, 0);
  // August is the nearest admissible month (after July, the latest statement holding the line).
  const aug = stOf(d, '2027-08', 'sp-a');
  assert.deepEqual(
    aug.items.map((i) => [i.kind, i.cause, i.serviceMonth, i.amount]),
    [['CORRECTION', 'CANCELLED', '2027-07', -cents('964.00')]],
  );
  // September shows the open August to the admin and cannot be approved before it.
  const sepSt = stOf(d, '2027-09', 'sp-a');
  assert.deepEqual(
    sepSt.flags.map((f) => [f.code, f.dueMonth, f.invoiceNumber]),
    [['EARLIER_PERIOD_OPEN', '2027-08', july.invoiceNumber]],
  );
  assert.equal(
    sepSt.items.some((i) => i.kind === 'CORRECTION'),
    false,
  );
  assert.throws(() => approve(reqOf(sepSt, 'rq-sep-early'), d), /STATEMENT_FLAGGED/);

  // August: −964.00 → nothing to invoice, the balance is carried (§5c).
  const a = approve(reqOf(aug, 'rq-aug'), d);
  assert.deepEqual(a, { id: 'ST-2', total: '-964.00', amountToInvoice: '0.00' });
  assert.deepEqual(mine(d.store, 'sp-a', '2027-08'), {
    month: '2027-08',
    state: 'NOTHING_TO_INVOICE',
    balanceCarriedForward: '-964.00',
    currency: 'CZK',
  });
  // September nets it: 1 200.00 − 964.00 = 236.00 to invoice; the correction is not repeated.
  const sep2 = stOf(d, '2027-09', 'sp-a');
  assert.deepEqual(
    [sep2.opening, sep2.total, sep2.amountToInvoice, sep2.flags.length],
    [-cents('964.00'), cents('1200.00'), cents('236.00'), 0],
  );
  approve(reqOf(sep2, 'rq-sep'), d);
  assert.equal(mine(d.store, 'sp-a', '2027-09').amountToInvoice, '236.00');
  d.today = '2027-11-01';
  assert.equal(preview({ ...d, month: '2027-10', mode: 'TEST' }).statements.length, 0);
});

test('R1 two months of one salesperson at once: one lock, a strict order, nothing twice or lost', () => {
  const lines = [line({}), line({ invoiceId: 'inv-sep', periodMonth: '2027-09' })];
  const d = deps(lines, () => attr(A, plan('b1', 1, '20.00', 24, '5.00')));
  approveAll(d, '2027-07');
  d.today = '2027-10-01';

  // (a) September is prepared; then a July invoice is issued late (due August) and August is
  // prepared too. Both pass step 1 — the transaction decides.
  const sepP = prepareApproval(reqOf(stOf(d, '2027-09', 'sp-a'), 'rq-sep'), d);
  lines.push(line({ invoiceId: 'inv-late', issuedAt: '2027-10-01T07:00:00Z' }));
  const augSt = stOf(d, '2027-08', 'sp-a');
  assert.deepEqual(
    augSt.items.map((i) => [i.kind, i.invoiceId, i.serviceMonth]),
    [['REGULAR', 'inv-late', '2027-07']],
  );
  const augP = prepareApproval(reqOf(augSt, 'rq-aug'), d);
  commitApproval(sepP, d); // September first
  assert.throws(() => commitApproval(augP, d), /PERIOD_ORDER/); // no statement before a later one
  // The late line is not lost: it is due in October (the month after the latest statement).
  d.today = '2027-11-01';
  const oct = stOf(d, '2027-10', 'sp-a');
  assert.deepEqual(
    oct.items.map((i) => [i.kind, i.invoiceId, i.serviceMonth, i.rate]),
    [['REGULAR', 'inv-late', '2027-07', '20.00']],
  );

  // (b) The other order: August commits first → the September prepared earlier is stale.
  const l2 = [
    line({ hotelId: 'h-9' }),
    line({ hotelId: 'h-9', invoiceId: 'inv-s2', periodMonth: '2027-09' }),
  ];
  const d2 = deps(l2, () => attr(B, plan('b2', 1, '10.00', 36, '3.00')));
  approveAll(d2, '2027-07');
  d2.today = '2027-10-01';
  const sep2 = prepareApproval(reqOf(stOf(d2, '2027-09', 'sp-b'), 'rq-s2'), d2);
  l2.push(line({ hotelId: 'h-9', invoiceId: 'inv-l2', issuedAt: '2027-10-01T07:00:00Z' }));
  commitApproval(prepareApproval(reqOf(stOf(d2, '2027-08', 'sp-b'), 'rq-a2'), d2), d2);
  assert.throws(() => commitApproval(sep2, d2), /STATEMENT_STALE/);
  approve(reqOf(stOf(d2, '2027-09', 'sp-b'), 'rq-s2b'), d2);
  assert.equal(d2.store.items.filter((i) => i.invoiceId === 'inv-l2').length, 1);
});

test('R1 one storno per original item is a DB uniqueness, not only the computation', () => {
  const july = line({ invoiceId: 'inv-j' });
  const d = deps([july, line({ invoiceId: 'inv-s', periodMonth: '2027-09' })], () =>
    attr(A, plan('b1', 1, '20.00', 24, '5.00')),
  );
  approveAll(d, '2027-07');
  july.cancelledAt = '2027-08-05T09:00:00Z';
  d.today = '2027-10-01';
  const aug = stOf(d, '2027-08', 'sp-a');
  const storno = aug.items[0];
  approve(reqOf(aug, 'rq-aug'), d);
  // A faulty or concurrent computation that carries the same storno into September again.
  const sepP = prepareApproval(reqOf(stOf(d, '2027-09', 'sp-a'), 'rq-sep'), d);
  sepP.st.items.push(storno);
  assert.throws(() => commitApproval(sepP, d), /CORRECTION_DUPLICATE/);
  assert.equal(d.store.statements.length, 2);
});

test('R2 a late invoice with no earlier statement of that salesperson: shown, approvable, never skipped', () => {
  const lines = [line({ hotelId: 'h-1' })];
  const table = (h) =>
    h === 'h-1'
      ? attr(A, plan('b1', 1, '20.00', 24, '5.00'))
      : attr(B, plan('b2', 1, '10.00', 36, '3.00'));
  const d = deps(lines, table);
  approveAll(d, '2027-07'); // only Alena had a July line
  // Bohdan's July invoice is issued after July was closed; he has no statement at all.
  lines.push(
    line({
      hotelId: 'h-2',
      hotelCode: 'HT-000002',
      invoiceId: 'inv-b',
      issuedAt: '2027-08-20T09:00:00Z',
    }),
  );
  // A July line without any attribution is shown too, in every later month until resolved.
  lines.push(
    line({
      hotelId: 'h-x',
      hotelCode: 'HT-X',
      invoiceId: 'inv-x',
      issuedAt: '2027-08-21T09:00:00Z',
    }),
  );
  const noX = (h, m) => (h === 'h-x' ? null : table(h, m));
  d.contract = contractOf(noX);
  d.today = '2027-09-01';

  const aug = preview({ ...d, month: '2027-08', mode: 'TEST' });
  const b = aug.statements.find((s) => s.salespersonId === 'sp-b');
  assert.deepEqual(
    b.flags.map((f) => [f.code, f.dueMonth, f.what]),
    [['EARLIER_PERIOD_OPEN', '2027-07', 'REGULAR:REGULAR']],
  );
  assert.deepEqual(
    aug.unassigned.map((u) => [u.hotelCode, u.serviceMonth]),
    [['HT-X', '2027-07']],
  );
  assert.throws(() => approve(reqOf(b, 'rq-b-aug'), d), /STATEMENT_FLAGGED/);
  // The path: Bohdan's own July statement — no earlier or zero statement is needed.
  const julB = stOf(d, '2027-07', 'sp-b');
  assert.deepEqual(
    julB.items.map((i) => [i.invoiceId, i.amount]),
    [['inv-b', cents('482.00')]],
  );
  approve(reqOf(julB, 'rq-b-jul'), d);
  assert.equal(mine(d.store, 'sp-b', '2027-07').amountToInvoice, '482.00');
  assert.equal(
    preview({ ...d, month: '2027-08', mode: 'TEST' }).statements.some(
      (s) => s.salespersonId === 'sp-b',
    ),
    false,
  );

  // Once Bohdan has a later statement, a still later July invoice goes to the month after it.
  lines.push(line({ hotelId: 'h-2', periodMonth: '2027-09', invoiceId: 'inv-b9' }));
  d.today = '2027-10-01';
  approve(reqOf(stOf(d, '2027-09', 'sp-b'), 'rq-b-sep'), d);
  lines.push(line({ hotelId: 'h-2', invoiceId: 'inv-b-late', issuedAt: '2027-10-02T09:00:00Z' }));
  d.today = '2027-11-01';
  assert.deepEqual(
    stOf(d, '2027-10', 'sp-b').items.map((i) => [i.invoiceId, i.serviceMonth]),
    [['inv-b-late', '2027-07']],
  );
});

test('R3 a replay: permission first, then the stored result — even with the core down or changed sources', () => {
  let rate = '20.00';
  let coreUp = true;
  const table = () => attr(A, plan('b1', 1, rate, 24, '5.00'));
  const calls = [];
  const live = contractOf(table, calls);
  const d = {
    ...deps([line({})], table),
    contract: (m, h) => {
      if (!coreUp) throw new ClosingError('CORE_UNAVAILABLE', 503);
      return live(m, h);
    },
    isApprover: (id) => id === 'admin' || id === 'admin-2',
  };
  const req = reqOf(stOf(d, '2027-07', 'sp-a'), 'rq-1');
  const first = approve(req, d);
  const n = calls.length;
  coreUp = false;
  assert.deepEqual(approve(req, d), first); // core down: the stored answer, no core call
  coreUp = true;
  rate = '30.00';
  assert.deepEqual(approve(req, d), first); // sources changed: still the stored answer
  assert.equal(calls.length, n);
  assert.throws(() => approve({ ...req, actorId: 'sales-1' }, d), /FORBIDDEN/); // permission first
  assert.throws(() => approve({ ...req, actorId: 'admin-2' }, d), /IDEMPOTENCY_CONFLICT/); // other actor
  coreUp = false;
  // A new request for the approved month: ALREADY_APPROVED from Finance alone, no core call.
  assert.throws(() => approve({ ...req, requestId: 'rq-new' }, d), /ALREADY_APPROVED/);
  // A new request for an open month needs the core: 503 and nothing written.
  d.today = '2027-09-01';
  assert.throws(
    () => approve({ ...req, requestId: 'rq-aug', month: '2027-08' }, d),
    (e) => e.status === 503,
  );
  assert.equal(d.store.statements.length, 1);
  assert.equal(d.store.operations.size, 1);
});

test('R3 the attribution version that counts is the one read at approval; a later correction becomes corrections', () => {
  let julyRecipient = 'A';
  const table = (h, m) =>
    m === '2027-07' && julyRecipient === 'B'
      ? attr(B, plan('b2', 1, '10.00', 36, '3.00'), '2027-06', 2)
      : attr(A, plan('b1', 1, '20.00', 24, '5.00'));
  const d = deps([line({})], table);
  // Step 1 reads revision 1; a correction committed in the core right after is not seen.
  const p = prepareApproval(reqOf(stOf(d, '2027-07', 'sp-a'), 'rq-jul'), d);
  julyRecipient = 'B';
  commitApproval(p, d);
  assert.deepEqual(
    d.store.items.map((i) => [i.salespersonId, i.attributionRevision, i.amount]),
    [['sp-a', 1, cents('964.00')]],
  );
  // The next month shows the difference per salesperson; July stays as approved.
  d.today = '2027-09-01';
  const aug = preview({ ...d, month: '2027-08', mode: 'TEST' });
  const by = Object.fromEntries(
    aug.statements.map((s) => [s.salespersonId, s.items.map((i) => [i.cause, i.rate, i.amount])]),
  );
  assert.deepEqual(by, {
    'sp-a': [['REATTRIBUTED:2', '20.00', -cents('964.00')]],
    'sp-b': [['REATTRIBUTED:2', '10.00', cents('482.00')]],
  });
  approveAll(d, '2027-08');
  assert.equal(d.store.statements[0].total, cents('964.00'));
  d.today = '2027-10-01';
  assert.equal(preview({ ...d, month: '2027-09', mode: 'TEST' }).statements.length, 0); // settled once
});
