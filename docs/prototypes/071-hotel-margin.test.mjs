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

// Every consumption is one core inventory movement with its own id (the cost key).
let movementSeq = 0;
const mv = () => `MV-${String(++movementSeq).padStart(4, '0')}`;
const newBottle = (on) => [
  { movementId: mv(), item: 'BOTTLE_330', itemKind: 'BOTTLE_BODY', unit: 'ks', qty: '1', on },
  { movementId: mv(), item: 'LABEL_HS', itemKind: 'LABEL', unit: 'ks', qty: '1', on },
  { movementId: mv(), item: 'PUMP_STD', itemKind: 'PUMP', unit: 'ks', qty: '1', on },
  { movementId: mv(), item: 'LIQ_HS', itemKind: 'LIQUID', unit: 'l', qty: '0.330', on },
];
// The refill: actual consumption is the fill only (washed pump from the pool, same bottle/label).
const refill = (on) => [
  { movementId: mv(), item: 'LIQ_HS', itemKind: 'LIQUID', unit: 'l', qty: '0.330', on },
];
const crate = (cycle, kind, consumed) =>
  Array.from({ length: 40 }, (_, i) => ({
    crateCycleId: cycle,
    bottleId: `B${String(i + 1).padStart(2, '0')}`,
    kind,
    consumed: consumed(kind === 'FIRST_USE' ? '2026-10-05' : '2026-11-04'),
  }));

// Salesperson S1 has hotel H; both monthly statements are approved.
const attribution = (hotelId, month, recipient, commissionStart = '2026-10') => ({
  hotelId,
  month,
  attribution: { commissionStart, recipient },
});
const S1 = { salespersonId: 'S1' };

const input = {
  revenueLines: [
    { lineId: 'IL-1', hotelId: H, periodMonth: '2026-10', amount: '4500.00', cancelled: false },
    { lineId: 'IL-2', hotelId: H, periodMonth: '2026-11', amount: '4500.00', cancelled: false },
    { lineId: 'IL-3', hotelId: H, periodMonth: '2026-11', amount: '4500.00', cancelled: true }, // storno: out
  ],
  circulations: [
    ...crate('CC-1', 'FIRST_USE', newBottle), // circulation 1
    ...crate('CC-2', 'REFILL', refill), // circulation 2 (same 40 bottles)
  ],
  dispatches: [
    { hotelId: H, crateCycleId: 'CC-1', dispatchedOn: '2026-10-06' },
    { hotelId: H, crateCycleId: 'CC-2', dispatchedOn: '2026-11-05' },
  ],
  // The October crate comes back on 3 Nov: the return rate counts only then (November).
  returns: [{ returnLineId: 'RL-1', hotelId: H, crateCycleId: 'CC-1', receivedOn: '2026-11-03' }],
  attributions: [attribution(H, '2026-10', S1), attribution(H, '2026-11', S1)],
  statements: [
    { statementId: 'ST-10', salespersonId: 'S1', month: '2026-10', approved: true },
    { statementId: 'ST-11', salespersonId: 'S1', month: '2026-11', approved: true },
  ],
  commissionItems: [
    {
      itemId: 'CI-1',
      statementId: 'ST-10',
      hotelId: H,
      serviceMonth: '2026-10',
      commission: '900.00',
    },
    {
      itemId: 'CI-2',
      statementId: 'ST-11',
      hotelId: H,
      serviceMonth: '2026-11',
      commission: '900.00',
    },
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
  assert.ok(r.lines.filter((l) => l.kind === 'MATERIAL').every((l) => l.item === 'LIQ_HS'));
  assert.equal(r.commissionState, 'APPROVED');
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
      { lineId: 'IL-4', hotelId: H, periodMonth: '2026-12', amount: '4500.00', cancelled: false },
    ],
    circulations: [
      ...input.circulations,
      // Two replacement bottles with a new label variant that has no standard price yet.
      ...[1, 2].map((n) => ({
        crateCycleId: 'CC-3',
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
    returns: [
      ...input.returns,
      { returnLineId: 'RL-2', hotelId: H, crateCycleId: 'CC-2', receivedOn: '2026-12-02' },
    ],
    // S1's December statement exists but is not approved yet: not the same as "no commission".
    attributions: [...input.attributions, attribution(H, '2026-12', S1)],
    statements: [
      ...input.statements,
      { statementId: 'ST-12', salespersonId: 'S1', month: '2026-12', approved: false },
    ],
    commissionItems: [
      ...input.commissionItems,
      {
        itemId: 'CI-3',
        statementId: 'ST-12',
        hotelId: H,
        serviceMonth: '2026-12',
        commission: '900.00',
      },
    ],
  };
  const r = hotelMonth(december, H, '2026-12', '2026-12-31');
  assert.equal(r.complete, false);
  assert.equal(r.marginBeforeCommission, null);
  assert.equal(r.marginAfterCommission, null);
  assert.deepEqual(
    r.missing.map((m) => `${m.kind}:${m.item ?? m.detail}`),
    ['PRICE:LABEL_HS_V2', 'PRICE:LABEL_HS_V2', 'COMMISSION:NOT_YET_APPROVED'],
  );
  assert.equal(r.commissionState, 'NOT_YET_APPROVED');
  // The unapproved commission is never counted as a cost, not even as "known so far".
  assert.equal(r.costs.commission, '0.00');
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
  assert.equal(companyView([hotelMonth(input, H, '2026-12', '2026-12-31')], []).complete, false);
});

// --- Firemní hotel: explicitly without commission (fixture) ------------------------------------
const F = 'hotel-firemni-smysleny';
const companyHotel = {
  ...input,
  revenueLines: [
    ...input.revenueLines,
    { lineId: 'IL-F1', hotelId: F, periodMonth: '2026-10', amount: '3000.00', cancelled: false },
  ],
  circulations: [
    ...input.circulations,
    ...Array.from({ length: 40 }, (_, i) => ({
      crateCycleId: 'CC-F1',
      bottleId: `F${String(i + 1).padStart(2, '0')}`,
      kind: 'FIRST_USE',
      consumed: newBottle('2026-10-07'),
    })),
  ],
  dispatches: [
    ...input.dispatches,
    { hotelId: F, crateCycleId: 'CC-F1', dispatchedOn: '2026-10-08' },
  ],
  // The core says: attribution in force, recipient null = Firemní hotel – bez provize.
  attributions: [...input.attributions, attribution(F, '2026-10', null)],
};

test('Firemní hotel: explicitly no commission is 0.00 and complete — not a missing approval', () => {
  const r = hotelMonth(companyHotel, F, '2026-10', '2026-11-15');
  assert.equal(r.complete, true);
  assert.equal(r.commissionState, 'NONE_COMPANY_HOTEL');
  assert.deepEqual(r.costs, {
    materials: '2764.00',
    outboundTransport: '95.00',
    returnTransport: '0.00',
    commission: '0.00',
  });
  assert.equal(r.marginBeforeCommission, '141.00');
  assert.equal(r.marginAfterCommission, '141.00');
  // Hotel H's October is unchanged by the other hotel's crate.
  assert.equal(hotelMonth(companyHotel, H, '2026-10', '2026-11-15').costs.materials, '2764.00');
});

test('no commission vs not yet approved vs no attribution are three different states', () => {
  const withRecipient = (statements) => ({
    ...companyHotel,
    attributions: [...input.attributions, attribution(F, '2026-10', { salespersonId: 'S2' })],
    statements: [...input.statements, ...statements],
  });
  // S2 has no statement for October yet: never read as "without commission".
  const pending = hotelMonth(withRecipient([]), F, '2026-10', '2026-11-15');
  assert.equal(pending.commissionState, 'NOT_YET_APPROVED');
  assert.equal(pending.complete, false);
  assert.equal(pending.marginAfterCommission, null);
  // S2's October statement is approved and has no item of hotel F: an explicit 0.00.
  const approvedNone = hotelMonth(
    withRecipient([
      { statementId: 'ST-S2-10', salespersonId: 'S2', month: '2026-10', approved: true },
    ]),
    F,
    '2026-10',
    '2026-11-15',
  );
  assert.equal(approvedNone.commissionState, 'APPROVED');
  assert.equal(approvedNone.complete, true);
  assert.equal(approvedNone.costs.commission, '0.00');
  // The commission of the attribution starts later: explicitly none for October.
  const later = hotelMonth(
    {
      ...companyHotel,
      attributions: [
        ...input.attributions,
        attribution(F, '2026-10', { salespersonId: 'S2' }, '2026-11'),
      ],
    },
    F,
    '2026-10',
    '2026-11-15',
  );
  assert.equal(later.commissionState, 'NONE_BEFORE_START');
  assert.equal(later.complete, true);
  // No attribution in force at all.
  const unassigned = hotelMonth(
    { ...companyHotel, attributions: input.attributions },
    F,
    '2026-10',
    '2026-11-15',
  );
  assert.equal(unassigned.commissionState, 'UNASSIGNED');
  assert.deepEqual(unassigned.missing, [{ kind: 'COMMISSION', detail: 'UNASSIGNED' }]);
  // An approved month with a later correction still waiting for approval is incomplete.
  const correction = hotelMonth(
    {
      ...input,
      commissionItems: [
        ...input.commissionItems,
        {
          itemId: 'CI-K1',
          statementId: 'ST-12',
          hotelId: H,
          serviceMonth: '2026-11',
          commission: '-900.00',
        },
      ],
      statements: [
        ...input.statements,
        { statementId: 'ST-12', salespersonId: 'S1', month: '2026-12', approved: false },
      ],
    },
    H,
    '2026-11',
    '2026-11-15',
  );
  assert.deepEqual(correction.missing, [
    { kind: 'COMMISSION', detail: 'CORRECTION_NOT_YET_APPROVED' },
  ]);
  assert.equal(correction.costs.commission, '900.00');
});

test('a missing standard price still blocks the Firemní hotel (no commission is no shortcut)', () => {
  const noPump = { ...companyHotel, prices: prices.filter((p) => p.item !== 'PUMP_STD') };
  const r = hotelMonth(noPump, F, '2026-10', '2026-11-15');
  assert.equal(r.complete, false);
  assert.equal(r.commissionState, 'NONE_COMPANY_HOTEL');
  assert.equal(r.marginBeforeCommission, null);
  assert.equal(r.missing.filter((m) => m.kind === 'PRICE' && m.item === 'PUMP_STD').length, 40);
});

// --- Repack: the recipient is the hotel of the crate the bottle was dispatched in ---------------

test('a bottle filled in one crate and repacked into another is costed once, to the dispatched crate’s hotel', () => {
  const fill = newBottle('2026-11-10');
  const repacked = {
    ...companyHotel,
    revenueLines: [
      ...companyHotel.revenueLines,
      { lineId: 'IL-F2', hotelId: F, periodMonth: '2026-11', amount: '3000.00', cancelled: false },
    ],
    attributions: [...companyHotel.attributions, attribution(F, '2026-11', null)],
    // P1 was filled in CC-7 (cancelled, never dispatched) and repacked into CC-8 for hotel F.
    // A repack has no movement: the fill movements stay those of 10 Nov.
    circulations: [
      ...companyHotel.circulations,
      {
        crateCycleId: 'CC-8',
        bottleId: 'P1',
        kind: 'FIRST_USE',
        filledInCrateCycleId: 'CC-7',
        consumed: fill,
      },
    ],
    dispatches: [
      ...companyHotel.dispatches,
      { hotelId: F, crateCycleId: 'CC-8', dispatchedOn: '2026-11-12' },
    ],
  };
  const f = hotelMonth(repacked, F, '2026-11', '2026-11-15');
  // 18.00 + 2.50 + 9.00 + 0.330 × 130.00 = 72.40, once
  assert.equal(f.costs.materials, '72.40');
  assert.deepEqual(
    f.lines.filter((l) => l.kind === 'MATERIAL').map((l) => [l.key, l.crateCycleId]),
    fill.map((u) => [`MATERIAL:${u.movementId}`, 'CC-8']),
  );
  // Hotel H's November is untouched.
  assert.equal(hotelMonth(repacked, H, '2026-11', '2026-11-15').costs.materials, '1716.00');

  // If the core ever reported the same fill under the old crate too, it is a data error.
  const twice = {
    ...repacked,
    circulations: [
      ...repacked.circulations,
      { crateCycleId: 'CC-2', bottleId: 'P1', kind: 'FIRST_USE', consumed: fill },
    ],
  };
  assert.throws(
    () => hotelMonth(twice, H, '2026-11', '2026-11-15'),
    (e) => e instanceof MarginError && e.code === 'DUPLICATE_COST_KEY',
  );
  // A circulation of a crate that was never dispatched has no recipient: refused, never guessed.
  const orphan = {
    ...repacked,
    circulations: [
      ...repacked.circulations,
      {
        crateCycleId: 'CC-7',
        bottleId: 'P2',
        kind: 'FIRST_USE',
        consumed: newBottle('2026-11-10'),
      },
    ],
  };
  assert.throws(
    () => hotelMonth(orphan, F, '2026-11', '2026-11-15'),
    (e) => e instanceof MarginError && e.code === 'CIRCULATION_NOT_DISPATCHED',
  );
});

test('every amount has one unique key: a crate dispatched or returned twice is refused', () => {
  const r = hotelMonth(input, H, '2026-11', '2026-11-15');
  const keys = [...r.revenueKeys, ...r.lines.map((l) => l.key)];
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('REVENUE:IL-2') && !keys.includes('REVENUE:IL-3'));
  assert.ok(
    keys.includes('OUTBOUND:CC-2') &&
      keys.includes('RETURN:RL-1') &&
      keys.includes('COMMISSION:CI-2'),
  );
  const dup = (patch) => () => hotelMonth({ ...input, ...patch }, H, '2026-11', '2026-11-15');
  const isDup = (e) => e instanceof MarginError && e.code === 'DUPLICATE_COST_KEY';
  assert.throws(dup({ dispatches: [...input.dispatches, input.dispatches[1]] }), isDup);
  assert.throws(
    dup({ returns: [...input.returns, { ...input.returns[0], returnLineId: 'RL-9' }] }),
    isDup,
  );
  assert.throws(
    dup({ commissionItems: [...input.commissionItems, input.commissionItems[1]] }),
    isDup,
  );
});
