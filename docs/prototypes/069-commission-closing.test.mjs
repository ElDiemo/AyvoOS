// node --test docs/prototypes/069-commission-closing.test.mjs — doc 069 §8 scenarios.
// Synthetic data only (fictional hotels, invoices and people).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClosingError,
  approve,
  approvedVsComputed,
  cents,
  commission,
  createStore,
  mine,
  payoutPlan,
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
