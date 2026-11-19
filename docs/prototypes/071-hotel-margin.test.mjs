// node --test docs/prototypes/071-hotel-margin.test.mjs — doc 071 §7 example (two circulations).
// Fictional data only: one fictional hotel, made-up prices and rates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarginError, companyView, hotelMonth, priceAt } from './071-hotel-margin.mjs';

const H = 'hotel-smysleny';
const net = { currency: 'CZK', vat: 'EXCLUDED' };
const prices = [
  {
    item: 'BOTTLE_330',
    unit: 'ks',
    price: '18.0000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
  {
    item: 'LABEL_HS',
    unit: 'ks',
    price: '2.5000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
  {
    item: 'PUMP_STD',
    unit: 'ks',
    price: '9.0000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
  {
    item: 'LIQ_HS',
    unit: 'l',
    price: '120.0000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
  // A new price from November …
  {
    item: 'LIQ_HS',
    unit: 'l',
    price: '130.0000',
    effectiveFrom: '2026-11-01',
    recordedAt: '2026-10-28',
    ...net,
  },
  // … corrected later for the same effective day (a new version, never an edit).
  {
    item: 'LIQ_HS',
    unit: 'l',
    price: '128.0000',
    effectiveFrom: '2026-11-01',
    recordedAt: '2026-11-20',
    ...net,
  },
];
const rates = [
  {
    item: 'OUTBOUND_CRATE',
    unit: 'crate',
    price: '95.0000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
  {
    item: 'RETURN_CRATE',
    unit: 'crate',
    price: '80.0000',
    effectiveFrom: '2026-09-01',
    recordedAt: '2026-08-25',
    ...net,
  },
];

const newBottle = (on) => [
  { item: 'BOTTLE_330', itemKind: 'BOTTLE_BODY', unit: 'ks', qty: '1', on },
  { item: 'LABEL_HS', itemKind: 'LABEL', unit: 'ks', qty: '1', on },
  { item: 'PUMP_STD', itemKind: 'PUMP', unit: 'ks', qty: '1', on },
  { item: 'LIQ_HS', itemKind: 'LIQUID', unit: 'l', qty: '0.330', on },
];
// The refill: actual consumption is the fill only (washed pump from the pool, same bottle/label).
const refill = (on) => [{ item: 'LIQ_HS', itemKind: 'LIQUID', unit: 'l', qty: '0.330', on }];
const crate = (cycle, kind, consumed, dispatchedOn) =>
  Array.from({ length: 40 }, (_, i) => ({
    hotelId: H,
    crateCycleId: cycle,
    dispatchedOn,
    bottleId: `B${String(i + 1).padStart(2, '0')}`,
    kind,
    consumed: consumed(kind === 'FIRST_USE' ? '2026-10-05' : '2026-11-04'),
  }));

const input = {
  revenueLines: [
    { hotelId: H, periodMonth: '2026-10', amount: '4500.00', cancelled: false },
    { hotelId: H, periodMonth: '2026-11', amount: '4500.00', cancelled: false },
    { hotelId: H, periodMonth: '2026-11', amount: '4500.00', cancelled: true }, // storno: out
  ],
  circulations: [
    ...crate('CC-1', 'FIRST_USE', newBottle, '2026-10-06'), // circulation 1
    ...crate('CC-2', 'REFILL', refill, '2026-11-05'), // circulation 2 (same 40 bottles)
  ],
  dispatches: [
    { hotelId: H, crateCycleId: 'CC-1', dispatchedOn: '2026-10-06' },
    { hotelId: H, crateCycleId: 'CC-2', dispatchedOn: '2026-11-05' },
  ],
  // The October crate comes back on 3 Nov: the return rate counts only then (November).
  returns: [{ hotelId: H, crateCycleId: 'CC-1', receivedOn: '2026-11-03' }],
  commissions: [
    { hotelId: H, serviceMonth: '2026-10', commission: '900.00', approved: true },
    { hotelId: H, serviceMonth: '2026-11', commission: '900.00', approved: true },
  ],
  prices,
  rates,
};

test('circulation 1 (October): a new bottle carries its packaging and fill; transport out at dispatch', () => {
  const r = hotelMonth(input, H, '2026-10', '2026-11-15');
  assert.equal(r.complete, true);
  assert.equal(r.revenue, '4500.00');
  // 40 × (18.00 + 2.50 + 9.00 + 0.330 × 120.00 = 69.10)
  assert.deepEqual(r.costs, {
    materials: '2764.00',
    outboundTransport: '95.00',
    returnTransport: '0.00', // not yet received
    commission: '900.00',
  });
  assert.equal(r.marginBeforeCommission, '1641.00');
  assert.equal(r.marginAfterCommission, '741.00');
});

test('circulation 2 (November): the refill carries the fill only; the return rate at the receipt', () => {
  const r = hotelMonth(input, H, '2026-11', '2026-11-15');
  assert.equal(r.complete, true);
  assert.equal(r.revenue, '4500.00'); // the cancelled line is out
  // 40 × 0.330 × 130.00 = 1716.00 — no bottle, label or pump again
  assert.deepEqual(r.costs, {
    materials: '1716.00',
    outboundTransport: '95.00',
    returnTransport: '80.00',
    commission: '900.00',
  });
  assert.equal(r.marginBeforeCommission, '2609.00');
  assert.equal(r.marginAfterCommission, '1709.00');
  assert.ok(r.lines.every((l) => l.item === 'LIQ_HS'));
});

test('validity: the version in force on the day; a later correction applies only as of its recording', () => {
  assert.equal(priceAt(prices, 'LIQ_HS', '2026-10-31', '2026-12-01').price, '120.0000');
  assert.equal(priceAt(prices, 'LIQ_HS', '2026-11-04', '2026-11-15').price, '130.0000');
  assert.equal(priceAt(prices, 'LIQ_HS', '2026-11-04', '2026-12-01').price, '128.0000');
  assert.equal(priceAt(prices, 'LIQ_HS', '2026-08-31', '2026-12-01'), null);
  // Recomputed after the correction: 40 × 0.330 × 128.00 = 1689.60
  const r = hotelMonth(input, H, '2026-11', '2026-12-01');
  assert.equal(r.costs.materials, '1689.60');
  assert.equal(r.marginBeforeCommission, '2635.40');
});

test('a missing price makes the month visibly incomplete — never a zero cost, never a final margin', () => {
  const december = {
    ...input,
    revenueLines: [
      ...input.revenueLines,
      { hotelId: H, periodMonth: '2026-12', amount: '4500.00', cancelled: false },
    ],
    circulations: [
      ...input.circulations,
      // Two replacement bottles with a new label variant that has no standard price yet.
      ...[1, 2].map((n) => ({
        hotelId: H,
        crateCycleId: 'CC-3',
        dispatchedOn: '2026-12-04',
        bottleId: `N${n}`,
        kind: 'FIRST_USE',
        consumed: newBottle('2026-12-03').map((u) =>
          u.item === 'LABEL_HS' ? { ...u, item: 'LABEL_HS_V2' } : u,
        ),
      })),
    ],
    dispatches: [
      ...input.dispatches,
      { hotelId: H, crateCycleId: 'CC-3', dispatchedOn: '2026-12-04' },
    ],
    returns: [...input.returns, { hotelId: H, crateCycleId: 'CC-2', receivedOn: '2026-12-02' }],
    commissions: [
      ...input.commissions,
      { hotelId: H, serviceMonth: '2026-12', commission: '900.00', approved: false },
    ],
  };
  const r = hotelMonth(december, H, '2026-12', '2026-12-31');
  assert.equal(r.complete, false);
  assert.equal(r.marginBeforeCommission, null);
  assert.equal(r.marginAfterCommission, null);
  assert.deepEqual(
    r.missing.map((m) => `${m.kind}:${m.item ?? m.detail}`),
    ['PRICE:LABEL_HS_V2', 'PRICE:LABEL_HS_V2', 'COMMISSION:statement not approved'],
  );
  // What is known is still shown, labelled as known so far: 2 × (18 + 9 + 0.33 × 128) + 95 + 80.
  assert.equal(r.costs.materials, '138.48');
  assert.equal(r.knownCostsSoFar, '313.48');
});

test('a refill that reports the bottle or the label again is a data error, never priced', () => {
  const bad = {
    ...input,
    circulations: [{ ...input.circulations[40], consumed: newBottle('2026-11-04') }],
  };
  assert.throws(
    () => hotelMonth(bad, H, '2026-11', '2026-11-15'),
    (e) => e instanceof MarginError && e.code === 'REFILL_CARRIES_PACKAGING',
  );
});

test('only CZK without VAT', () => {
  const eur = [{ ...prices[0], currency: 'EUR' }];
  assert.throws(() => priceAt(eur, 'BOTTLE_330', '2026-10-05', '2026-12-01'), /PRICE_NOT_CZK_NET/);
});

test('the hotel contribution is not the company result (overheads are never allocated)', () => {
  const nov = hotelMonth(input, H, '2026-11', '2026-11-15');
  const company = companyView(
    [nov],
    [
      { name: 'nájem (smyšlený)', amount: '15000.00' },
      { name: 'účetní (smyšlená)', amount: '3000.00' },
    ],
  );
  assert.deepEqual(company, {
    complete: true,
    contributions: '1709.00',
    overheads: '18000.00',
    result: '-16291.00',
  });
  assert.equal(
    companyView([hotelMonth({ ...input, commissions: [] }, H, '2026-12', '2026-12-31')], [])
      .complete,
    false,
  );
});
