import { spawnSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BillingAgreementDetail,
  BillingCustomerDetail,
  EffectiveTermsPage,
  PriceListVersion,
} from '@ayvo/types';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import { PrismaClient as CorePrismaClient } from '../src/generated/prisma/client.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { createHotel } from './support/order-fixtures.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { databaseUrl, hasDatabase } from './support/test-app.js';

/**
 * Hotel billing settings (doc 040, N3A-1) in the Finance unit, against a real core and real DB
 * roles: customers with versions, one agreement per hotel with versioned (bitemporal) terms, the
 * default price list, the terms effective for a month — also as known at an earlier moment —,
 * exact decimal prices, idempotency and concurrency, the append-only rules, the permissions and
 * the core being down. Synthetic companies and hotels only. No amounts or invoices exist yet.
 */
const B = '/api/admin/finance/billing';
const apiRoot = resolve(import.meta.dirname, '..');

describe.skipIf(!hasDatabase)('finance hotel billing settings (N3A-1)', () => {
  let f: FinanceTestApp;
  const customerBody = (over: Record<string, unknown> = {}) => ({
    legalName: `Hotelová společnost ${randomUUID().slice(0, 6)} s.r.o.`,
    companyId: '12345678',
    vatId: 'CZ12345678',
    addressLine1: 'Testovací 1',
    addressLine2: null,
    postalCode: '110 00',
    city: 'Praha',
    countryCode: 'CZ',
    billingEmail: 'fakturace@hotel.test',
    ...over,
  });
  const newCustomer = async (over: Record<string, unknown> = {}) =>
    (
      await f
        .post(`${B}/customers`)
        .send({ requestId: randomUUID(), customer: customerBody(over) })
        .expect(201)
    ).body as BillingCustomerDetail;
  const terms = (customerId: string, over: Record<string, unknown> = {}) => ({
    effectiveFrom: '2026-01',
    customerId,
    contractNumber: 'SML-TEST-1',
    billedRooms: 40,
    ownPricePerRoomMonth: null,
    currency: 'CZK',
    paymentTermsDays: 14,
    billingTiming: 'ARREARS',
    validFrom: '2026-01-01',
    validTo: null,
    reason: 'Smlouva podepsána (syntetická)',
    ...over,
  });
  /** A synthetic core hotel; its id is read from the core (the admin API exposes the code). */
  const newHotel = async () => {
    const h = await createHotel(f.core);
    const { id } = await f.core.prisma.hotel.findUniqueOrThrow({
      where: { code: h.code },
      select: { id: true },
    });
    return { id, code: h.code, name: h.name };
  };
  const newAgreement = async (hotelId: string, t: Record<string, unknown>) =>
    (
      await f
        .post(`${B}/agreements`)
        .send({ requestId: randomUUID(), hotelId, terms: t })
        .expect(201)
    ).body as BillingAgreementDetail;
  const agreementDetail = async (code: string) =>
    (await f.get(`${B}/agreements/${code}`).expect(200)).body as BillingAgreementDetail;
  /** A new version edited from the agreement's current revision (as the form would). */
  const addVersion = async (code: string, t: Record<string, unknown>) => {
    const expectedRevision = (await agreementDetail(code)).versions[0]!.revision;
    return (
      await f
        .post(`${B}/agreements/${code}/versions`)
        .send({ requestId: randomUUID(), expectedRevision, terms: t })
        .expect(201)
    ).body as BillingAgreementDetail;
  };
  const effective = async (month: string, code: string, asOf?: string) => {
    const page = (
      await f
        .get(`${B}/agreements/effective?month=${month}${asOf ? `&asOf=${asOf}` : ''}`)
        .expect(200)
    ).body as EffectiveTermsPage;
    return page.items.find((i) => i.agreement.code === code);
  };
  /** The next revision, taken from the real counter like the service does (owner connection). */
  const nextRevision = async (db: PrismaClient) =>
    (
      await db.$queryRaw<{ v: bigint }[]>`
        UPDATE finance.code_counters SET last_value = last_value + 1
        WHERE name = 'billing_revision' RETURNING last_value AS v`
    )[0]!.v;
  /**
   * A synthetic currency "X??" never used before in this run: two letters A–Z (676 codes) drawn at
   * random, unique within the file (two equal codes in one test merged its scenarios).
   */
  const usedCurrencies = new Set<string>();
  const testCurrency = (): string => {
    const letter = () => String.fromCharCode(65 + randomInt(26));
    const code = `X${letter()}${letter()}`;
    if (usedCurrencies.has(code)) return testCurrency();
    usedCurrencies.add(code);
    return code;
  };
  const price = (
    currency: string,
    pricePerRoomMonth: string,
    effectiveFrom: string,
    expectedRevision: number | null = null,
  ) =>
    f.post(`${B}/price-list`).send({
      requestId: randomUUID(),
      expectedRevision,
      currency,
      pricePerRoomMonth,
      effectiveFrom,
      reason: 'test',
    });

  beforeAll(async () => {
    f = await createFinanceTestApp();
  });
  afterAll(() => f?.close());

  it('customers: created, versioned with a reason, the newest is current, history kept; bad data refused', async () => {
    const c = await newCustomer();
    expect(c.code).toMatch(/^CU-\d{6}$/);
    expect(c.current.version).toBe(1);
    expect(c.current.reason).toBeNull();
    const v2 = (
      await f
        .post(`${B}/customers/${c.code}/versions`)
        .send({
          requestId: randomUUID(),
          expectedVersion: 1,
          customer: customerBody({ city: 'Brno', postalCode: '602 00' }),
          reason: 'Změna sídla',
        })
        .expect(201)
    ).body as BillingCustomerDetail;
    expect(v2.current).toMatchObject({ version: 2, reason: 'Změna sídla' });
    expect(v2.current.customer.city).toBe('Brno');
    expect(v2.versions.map((v) => v.version)).toEqual([2, 1]);
    // A new version needs a reason; invalid e-mail, country and Czech IČO are refused.
    await f
      .post(`${B}/customers/${c.code}/versions`)
      .send({ requestId: randomUUID(), expectedVersion: 2, customer: customerBody(), reason: '' })
      .expect(400);
    for (const bad of [{ billingEmail: 'neni-email' }, { countryCode: 'cz' }, { companyId: '123' }])
      await f
        .post(`${B}/customers`)
        .send({ requestId: randomUUID(), customer: customerBody(bad) })
        .expect(400);
    // A foreign company: its id is free text.
    await newCustomer({ countryCode: 'DE', companyId: 'HRB 12345', vatId: 'DE123456789' });
  });

  it('agreements: one per hotel, the hotel must exist in the core, the customer must exist', async () => {
    const c = await newCustomer();
    const hotel = await newHotel();
    const a = await newAgreement(hotel.id, terms(c.id));
    expect(a.code).toMatch(/^BA-\d{6}$/);
    expect(a.hotel).toEqual({ id: hotel.id, code: hotel.code, name: hotel.name });
    expect(a.versions).toHaveLength(1);
    expect(a.versions[0]).toMatchObject({ billedRooms: 40, ownPricePerRoomMonth: null });
    const second = await f
      .post(`${B}/agreements`)
      .send({ requestId: randomUUID(), hotelId: hotel.id, terms: terms(c.id) })
      .expect(409);
    expect(second.body.code).toBe('AGREEMENT_EXISTS');
    const noHotel = await f
      .post(`${B}/agreements`)
      .send({ requestId: randomUUID(), hotelId: randomUUID(), terms: terms(c.id) })
      .expect(422);
    expect(noHotel.body.code).toBe('HOTEL_NOT_FOUND');
    const other = await newHotel();
    const noCustomer = await f
      .post(`${B}/agreements`)
      .send({ requestId: randomUUID(), hotelId: other.id, terms: terms(randomUUID()) })
      .expect(422);
    expect(noCustomer.body.code).toBe('CUSTOMER_NOT_FOUND');
    // The hotels to choose from come from the core contract (identity and address only).
    const hotels = (await f.get(`${B}/hotels`).expect(200)).body as Record<string, unknown>[];
    const listed = hotels.find((h) => h.id === hotel.id)!;
    expect(Object.keys(listed).sort()).toEqual([
      'addressLine1',
      'addressLine2',
      'city',
      'code',
      'countryCode',
      'id',
      'name',
      'postalCode',
    ]);
  });

  it('terms: first day of a month only; rooms ≥ 1; an explicit 0.00 differs from the default; exact decimals', async () => {
    const c = await newCustomer();
    for (const bad of [
      { effectiveFrom: '2026-1' },
      { billedRooms: 0 },
      { billedRooms: -3 },
      { ownPricePerRoomMonth: '-1.00' },
      { ownPricePerRoomMonth: '1.005' },
      { ownPricePerRoomMonth: 320 },
      { billingTiming: 'MONTHLY' },
      { validTo: '2025-12-31' },
      { paymentTermsDays: 400 },
    ])
      expect(
        (
          await f.post(`${B}/agreements`).send({
            requestId: randomUUID(),
            hotelId: (await newHotel()).id,
            terms: terms(c.id, bad),
          })
        ).status,
        JSON.stringify(bad),
      ).toBe(400);
    const zero = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '0' }),
    );
    expect(zero.versions[0]!.ownPricePerRoomMonth).toBe('0.00');
    const big = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '12345678901234567.89' }),
    );
    expect(big.versions[0]!.ownPricePerRoomMonth).toBe('12345678901234567.89');
    // The database refuses a mid-month effective date on its own (not only the API).
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO finance.agreement_versions (revision, agreement_id, effective_from, customer_id, billed_rooms,
             currency, payment_terms_days, billing_timing, valid_from, reason, recorded_by, recorded_by_name, request_id)
           VALUES (${await nextRevision(owner)}, '${zero.id}', '2026-03-15', '${c.id}', 5, 'CZK', 14, 'ARREARS', '2026-01-01', 'x',
             '${randomUUID()}', 'x', '${randomUUID()}')`,
        ),
      ).rejects.toThrow(/check constraint/);
    } finally {
      await owner.$disconnect();
    }
  });

  it('effective terms per month: the newest effective version applies; before it nothing is in effect', async () => {
    const c = await newCustomer();
    const a = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '320.00' }),
    );
    await addVersion(
      a.code,
      terms(c.id, {
        effectiveFrom: '2026-03',
        billedRooms: 45,
        ownPricePerRoomMonth: '320.00',
        reason: 'Rozšíření o křídlo B',
      }),
    );
    expect((await effective('2026-02', a.code))!.version!.billedRooms).toBe(40);
    const march = (await effective('2026-03', a.code))!;
    expect(march.version!.billedRooms).toBe(45);
    expect(march.price).toMatchObject({ source: 'OWN', perRoomMonth: '320.00' });
    expect(march.status).toBe('IN_EFFECT');
    expect(march.gaps).toEqual([]);
    expect(march.customer).toMatchObject({ id: c.id, code: c.code });
    expect(await effective('2025-12', a.code)).toMatchObject({
      status: 'NOT_IN_EFFECT',
      version: null,
      gaps: [],
    });
  });

  it('a correction recorded later wins; the state as known before it is reconstructed exactly', async () => {
    const c = await newCustomer();
    const a = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '300.00' }),
    );
    await new Promise((r) => setTimeout(r, 15));
    const beforeCorrection = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    await addVersion(
      a.code,
      terms(c.id, { ownPricePerRoomMonth: '310.00', reason: 'Oprava překlepu v ceně' }),
    );
    expect((await effective('2026-01', a.code))!.price.perRoomMonth).toBe('310.00');
    expect((await effective('2026-01', a.code, beforeCorrection))!.price.perRoomMonth).toBe(
      '300.00',
    );
    // Before the agreement existed: it is not listed at all.
    expect(await effective('2026-01', a.code, '2020-01-01T00:00:00.000Z')).toBeUndefined();
    // Every version stays in the history, newest recorded first.
    const detail = (await f.get(`${B}/agreements/${a.code}`).expect(200))
      .body as BillingAgreementDetail;
    expect(detail.versions.map((v) => v.ownPricePerRoomMonth)).toEqual(['310.00', '300.00']);
  });

  it('tied recording time (review N3A74-R1): the higher revision wins whatever the row order; every read agrees', async () => {
    // Two versions effective the same month and recorded in the same millisecond, written straight
    // into the real tables in both physical orders. Only the revision may decide.
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    const c = await newCustomer();
    const [curA, curB] = [testCurrency(), testCurrency()];
    const byPrice = {
      [curA]: await newAgreement((await newHotel()).id, terms(c.id, { currency: curA })),
      [curB]: await newAgreement((await newHotel()).id, terms(c.id, { currency: curB })),
    };
    // Agreement terms: own prices on agreements whose first version (300.00, January) is earlier.
    const terms1 = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '300.00' }),
    );
    const terms2 = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '300.00' }),
    );
    // The tied moment: after everything above, so "as known then" lists the agreements.
    const at = new Date();
    const insertPrice = async (revision: bigint, currency: string, value: string) =>
      owner.$executeRaw`
        INSERT INTO finance.price_list_versions (revision, currency, price_per_room_month,
          effective_from, reason, recorded_at, recorded_by, recorded_by_name, request_id)
        VALUES (${revision}, ${currency}, ${value}::numeric, '2026-01-01', 'tie test', ${at},
          ${randomUUID()}::uuid, 'test', ${randomUUID()}::uuid)`;
    const insertTerms = async (
      revision: bigint,
      agreementId: string,
      customerId: string,
      own: string,
    ) =>
      owner.$executeRaw`
        INSERT INTO finance.agreement_versions (revision, agreement_id, effective_from, customer_id,
          billed_rooms, own_price_per_room_month, currency, payment_terms_days, billing_timing,
          valid_from, reason, recorded_at, recorded_by, recorded_by_name, request_id)
        VALUES (${revision}, ${agreementId}::uuid, '2026-02-01', ${customerId}::uuid, 40,
          ${own}::numeric, 'CZK', 14, 'ARREARS', '2026-01-01', 'tie test', ${at},
          ${randomUUID()}::uuid, 'test', ${randomUUID()}::uuid)`;
    try {
      // Price list: the higher revision inserted first (A), then last (B).
      for (const [cur, firstIsHigher] of [
        [curA, true],
        [curB, false],
      ] as const) {
        const lo = await nextRevision(owner);
        const hi = await nextRevision(owner);
        const rows: [bigint, string][] = [
          [hi, '999.00'],
          [lo, '320.00'],
        ];
        for (const [rev, value] of firstIsHigher ? rows : rows.reverse())
          await insertPrice(rev, cur, value);
      }
      // Agreement terms: the same, effective from February.
      for (const [a, firstIsHigher] of [
        [terms1, true],
        [terms2, false],
      ] as const) {
        const lo = await nextRevision(owner);
        const hi = await nextRevision(owner);
        const rows: [bigint, string][] = [
          [hi, '999.00'],
          [lo, '320.00'],
        ];
        for (const [rev, own] of firstIsHigher ? rows : rows.reverse())
          await insertTerms(rev, a.id, c.id, own);
      }
      // Repeated reads, now and as known at the tied moment itself: always the higher revision.
      for (let i = 0; i < 5; i++) {
        for (const cur of [curA, curB]) {
          expect((await effective('2026-01', byPrice[cur]!.code))!.price.perRoomMonth).toBe(
            '999.00',
          );
          expect(
            (await effective('2026-01', byPrice[cur]!.code, at.toISOString()))!.price.perRoomMonth,
          ).toBe('999.00');
        }
        for (const a of [terms1, terms2]) {
          const feb = (await effective('2026-02', a.code))!;
          expect(feb.price).toMatchObject({ source: 'OWN', perRoomMonth: '999.00' });
          // January keeps the first version (the tied ones start in February).
          expect((await effective('2026-01', a.code))!.price.perRoomMonth).toBe('300.00');
        }
      }
      // The history and the price list are ordered by revision too, never by the row order.
      for (const a of [terms1, terms2]) {
        const detail = (await f.get(`${B}/agreements/${a.code}`).expect(200))
          .body as BillingAgreementDetail;
        expect(detail.versions.map((v) => v.ownPricePerRoomMonth)).toEqual([
          '999.00',
          '320.00',
          '300.00',
        ]);
        const revs = detail.versions.map((v) => v.revision);
        expect(revs).toEqual([...revs].sort((x, y) => y - x));
      }
      const list = (await f.get(`${B}/price-list`).expect(200)).body as PriceListVersion[];
      for (const cur of [curA, curB])
        expect(list.filter((p) => p.currency === cur).map((p) => p.pricePerRoomMonth)).toEqual([
          '999.00',
          '320.00',
        ]);
      // A revision is unique in the table itself (the counter keeps them apart across tables).
      const taken = list.find((p) => p.currency === curA)!.revision;
      await expect(insertPrice(BigInt(taken), curA, '1.00')).rejects.toThrow(/unique/i);
    } finally {
      await owner.$disconnect();
    }
  });

  it('the default price list: by currency and month; another currency or no list is a gap, never 0', async () => {
    const currency = testCurrency();
    const c = await newCustomer();
    const a = await newAgreement((await newHotel()).id, terms(c.id, { currency }));
    expect(await effective('2026-01', a.code)).toMatchObject({
      price: { source: 'MISSING', perRoomMonth: null },
      gaps: ['PRICE_MISSING'],
    });
    await price(currency, '320.00', '2026-01').expect(201);
    await price(currency, '330.50', '2026-04').expect(201);
    expect((await effective('2026-03', a.code))!.price).toMatchObject({
      source: 'DEFAULT',
      perRoomMonth: '320.00',
    });
    expect((await effective('2026-04', a.code))!.price.perRoomMonth).toBe('330.50');
    // An explicit own 0.00 is a price, not a gap.
    await addVersion(
      a.code,
      terms(c.id, { currency, effectiveFrom: '2026-05', ownPricePerRoomMonth: '0.00' }),
    );
    expect(await effective('2026-05', a.code)).toMatchObject({
      price: { source: 'OWN', perRoomMonth: '0.00' },
      gaps: [],
    });
    await price(currency, '1.005', '2026-01').expect(400);
    await price(currency, '1', '2026-01-15').expect(400);
  });

  it('a month the agreement covers only partly is listed as "rule missing", never prorated or skipped', async () => {
    const c = await newCustomer();
    const a = await newAgreement(
      (await newHotel()).id,
      terms(c.id, {
        ownPricePerRoomMonth: '300.00',
        effectiveFrom: '2026-03',
        validFrom: '2026-03-15',
        validTo: '2026-06-10',
      }),
    );
    expect((await effective('2026-03', a.code))!.gaps).toEqual(['PARTIAL_PERIOD_RULE_MISSING']);
    expect((await effective('2026-04', a.code))!.gaps).toEqual([]);
    expect((await effective('2026-06', a.code))!.gaps).toEqual(['PARTIAL_PERIOD_RULE_MISSING']);
    expect((await effective('2026-07', a.code))!.status).toBe('NOT_IN_EFFECT');
    // Valid from mid-January but terms only from February: January's terms are missing.
    const b = await newAgreement(
      (await newHotel()).id,
      terms(c.id, {
        ownPricePerRoomMonth: '300.00',
        effectiveFrom: '2026-02',
        validFrom: '2026-01-20',
      }),
    );
    expect(await effective('2026-01', b.code)).toMatchObject({
      status: 'IN_EFFECT',
      gaps: ['NO_EFFECTIVE_VERSION'],
    });
  });

  it('idempotency: the same request replays; another payload under the same id is refused', async () => {
    const requestId = randomUUID();
    const body = { requestId, customer: customerBody({ legalName: 'Opakovaný s.r.o.' }) };
    const first = (await f.post(`${B}/customers`).send(body).expect(201)).body;
    const again = (await f.post(`${B}/customers`).send(body).expect(201)).body;
    expect(again.code).toBe(first.code);
    const other = await f
      .post(`${B}/customers`)
      .send({ requestId, customer: customerBody({ legalName: 'Jiný s.r.o.' }) })
      .expect(409);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a stale customer form (review N3A74-R2): refused with 409, never writes the old values back; replay and races', async () => {
    const c = await newCustomer({ billingEmail: 'old@example.test', city: 'Praha' });
    const v1 = c.current.customer;
    const save = (
      expectedVersion: number,
      customer: Record<string, unknown>,
      requestId = randomUUID(),
    ) =>
      f
        .post(`${B}/customers/${c.code}/versions`)
        .send({ requestId, expectedVersion, customer, reason: 'test' });
    // A and B both opened version 1. A changes the e-mail and saves.
    const aRequest = randomUUID();
    const aBody = { ...v1, billingEmail: 'new@example.test' };
    expect((await save(1, aBody, aRequest)).status).toBe(201);
    // B changes the city in its version-1 form and saves: refused, nothing written.
    const stale = await save(1, { ...v1, city: 'New city' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONCURRENT_CHANGE');
    let detail = (await f.get(`${B}/customers/${c.code}`).expect(200))
      .body as BillingCustomerDetail;
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail.current.customer).toMatchObject({
      billingEmail: 'new@example.test',
      city: 'Praha',
    });
    // B reloads (version 2) and saves its change on top: both changes are kept.
    expect((await save(2, { ...detail.current.customer, city: 'New city' })).status).toBe(201);
    detail = (await f.get(`${B}/customers/${c.code}`).expect(200)).body as BillingCustomerDetail;
    expect(detail.current).toMatchObject({
      version: 3,
      customer: { billingEmail: 'new@example.test', city: 'New city' },
    });
    // A's request replayed later: the stored result, no new version, nothing reverted.
    expect((await save(1, aBody, aRequest)).status).toBe(201);
    // The expected version is part of the request's fingerprint; it is required.
    expect((await save(3, aBody, aRequest)).body.code).toBe('IDEMPOTENCY_CONFLICT');
    await f
      .post(`${B}/customers/${c.code}/versions`)
      .send({ requestId: randomUUID(), customer: aBody, reason: 'test' })
      .expect(400);
    detail = (await f.get(`${B}/customers/${c.code}`).expect(200)).body as BillingCustomerDetail;
    expect(detail.current.version).toBe(3);
    // Three saves from version 3 at once: exactly one becomes version 4.
    const raced = await Promise.all(
      ['A', 'B', 'C'].map((x) => save(3, { ...detail.current.customer, city: `Race ${x}` })),
    );
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    detail = (await f.get(`${B}/customers/${c.code}`).expect(200)).body as BillingCustomerDetail;
    expect(detail.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  it('stale agreement terms and price forms (review N3A74-R2): refused with 409; races let exactly one in', async () => {
    const c = await newCustomer();
    const a = await newAgreement(
      (await newHotel()).id,
      terms(c.id, { ownPricePerRoomMonth: '300.00' }),
    );
    const opened = a.versions[0]!.revision;
    const saveTerms = (expectedRevision: number, over: Record<string, unknown>) =>
      f.post(`${B}/agreements/${a.code}/versions`).send({
        requestId: randomUUID(),
        expectedRevision,
        terms: terms(c.id, { ownPricePerRoomMonth: '300.00', ...over }),
      });
    expect((await saveTerms(opened, { billedRooms: 45 })).status).toBe(201);
    // A second form opened at the same revision changes the price: it would drop the 45 rooms.
    const stale = await saveTerms(opened, { ownPricePerRoomMonth: '310.00' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONCURRENT_CHANGE');
    let detail = await agreementDetail(a.code);
    expect(detail.versions).toHaveLength(2);
    expect((await effective('2026-01', a.code))!.version).toMatchObject({
      billedRooms: 45,
      ownPricePerRoomMonth: '300.00',
    });
    const current = detail.versions[0]!.revision;
    const raced = await Promise.all(
      [46, 47, 48].map((billedRooms) => saveTerms(current, { billedRooms })),
    );
    expect(raced.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    detail = await agreementDetail(a.code);
    expect(detail.versions).toHaveLength(3);

    // The default price of a currency and month: the same rule (null = none existed yet).
    const currency = testCurrency();
    const first = await price(currency, '320.00', '2026-01').expect(201);
    const seen = (first.body as PriceListVersion).revision;
    const again = await price(currency, '330.00', '2026-01');
    expect([again.status, again.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    await price(currency, '340.00', '2026-01', seen + 1000).expect(409);
    const racedPrices = await Promise.all(
      ['350.00', '360.00', '370.00'].map((v) => price(currency, v, '2026-01', seen)),
    );
    expect(racedPrices.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    // Another month of the same currency is its own slot.
    await price(currency, '400.00', '2026-02').expect(201);
    const list = (await f.get(`${B}/price-list`).expect(200)).body as PriceListVersion[];
    expect(list.filter((p) => p.currency === currency)).toHaveLength(3);
  });

  it('concurrency: two agreements for the same hotel at once — exactly one is created', async () => {
    const c = await newCustomer();
    const hotel = await newHotel();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        f
          .post(`${B}/agreements`)
          .send({ requestId: randomUUID(), hotelId: hotel.id, terms: terms(c.id) }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      expect(await owner.billingAgreement.count({ where: { hotelId: hotel.id } })).toBe(1);
    } finally {
      await owner.$disconnect();
    }
  });

  it('append-only and roles: no UPDATE/DELETE/TRUNCATE even for the owner; the runtime role cannot change rows; the core cannot read them', async () => {
    const c = await newCustomer();
    const a = await newAgreement((await newHotel()).id, terms(c.id));
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    const core = new CorePrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl! }),
    });
    try {
      for (const sql of [
        `UPDATE finance.agreement_versions SET billed_rooms = 1 WHERE agreement_id = '${a.id}'`,
        `DELETE FROM finance.agreement_versions WHERE agreement_id = '${a.id}'`,
        `UPDATE finance.customer_versions SET city = 'x' WHERE customer_id = '${c.id}'`,
        `DELETE FROM finance.billing_agreements WHERE id = '${a.id}'`,
        'TRUNCATE finance.price_list_versions',
        'TRUNCATE finance.customers CASCADE',
      ])
        await expect(owner.$executeRawUnsafe(sql), sql).rejects.toThrow(/not allowed/);
      for (const sql of [
        `UPDATE finance.agreement_versions SET billed_rooms = 1 WHERE agreement_id = '${a.id}'`,
        `DELETE FROM finance.customer_versions WHERE customer_id = '${c.id}'`,
        'TRUNCATE finance.billing_agreements',
      ])
        await expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
      for (const sql of [
        'SELECT 1 FROM finance.customers LIMIT 1',
        'SELECT 1 FROM finance.agreement_versions LIMIT 1',
        'SELECT 1 FROM finance.price_list_versions LIMIT 1',
      ])
        await expect(core.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all([owner.$disconnect(), runtime.$disconnect(), core.$disconnect()]);
    }
  });

  it('the core unavailable: creating an agreement answers 503 and writes nothing', async () => {
    const c = await newCustomer();
    const down = await createFinanceTestApp({ coreUrl: 'http://127.0.0.1:9' });
    try {
      // The guard asks the core who the caller is: unavailable → 503, nothing written.
      const before = await f.prisma.billingAgreement.count();
      const res = await down
        .post(`${B}/agreements`)
        .send({ requestId: randomUUID(), hotelId: randomUUID(), terms: terms(c.id) });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FINANCE_DEPENDENCY_UNAVAILABLE');
      expect(await f.prisma.billingAgreement.count()).toBe(before);
    } finally {
      await down.close();
    }
  });

  it('permissions with real sessions: billing_read reads only; without it everything is refused; ADMIN has both', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const grants = await real.core.prisma.rolePermission.findMany({
        where: { permissionCode: { startsWith: 'finance:billing' }, roleCode: 'ADMIN' },
        select: { permissionCode: true },
        orderBy: { permissionCode: 'asc' },
      });
      expect(grants.map((g) => g.permissionCode)).toEqual([
        'finance:billing_manage',
        'finance:billing_read',
      ]);
      const roleCode = `FINR_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Finance read (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.create({
        data: { roleCode, permissionCode: 'finance:billing_read' },
      });
      const reader = await prepareInvitedUser(real.core, {
        email: `fin-read-${randomUUID()}@ayvo.test`,
        displayName: 'Jen čtení',
      });
      await real.core.prisma.userRole.create({
        data: { userId: reader.id, roleCode, grantReason: 'test: billing read' },
      });
      const readCookie = await sessionCookie(real.core, reader.email);
      for (const path of [`${B}/customers`, `${B}/agreements`, `${B}/price-list`, `${B}/hotels`])
        expect([path, (await real.get(path, readCookie)).status]).toEqual([path, 200]);
      for (const [path, body] of [
        [`${B}/customers`, { requestId: randomUUID(), customer: customerBody() }],
        [
          `${B}/price-list`,
          {
            requestId: randomUUID(),
            expectedRevision: null,
            currency: 'CZK',
            pricePerRoomMonth: '1.00',
            effectiveFrom: '2026-01',
            reason: 'x',
          },
        ],
      ] as const)
        expect([path, (await real.post(path, readCookie).send(body)).status]).toEqual([path, 403]);

      const outsider = await prepareInvitedUser(real.core, {
        email: `fin-none-${randomUUID()}@ayvo.test`,
        displayName: 'Bez fakturace',
      });
      await real.core.prisma.userRole.create({
        data: {
          userId: outsider.id,
          roleCode: 'SALES',
          grantReason: 'test: no billing permission',
        },
      });
      const outCookie = await sessionCookie(real.core, outsider.email);
      for (const path of [
        `${B}/customers`,
        `${B}/agreements`,
        `${B}/hotels`,
        `${B}/agreements/effective?month=2026-01`,
      ])
        expect([path, (await real.get(path, outCookie)).status]).toEqual([path, 403]);
      await request(real.app.getHttpServer()).get(`${B}/customers`).expect(401);
    } finally {
      await real.close();
    }
  });

  it('the core contract of hotels needs the service token and finance:billing_read', async () => {
    const core = request(f.core.app.getHttpServer());
    const res = await core.get('/api/internal/v1/finance/hotels').expect(401);
    expect(res.body.code).toBe('SERVICE_UNAUTHENTICATED');
  });

  it('the Finance schema of the test database has no drift from its Prisma schema', () => {
    const res = spawnSync(
      resolve(apiRoot, 'node_modules/.bin/prisma'),
      [
        'migrate',
        'diff',
        '--config',
        'prisma-finance.config.ts',
        '--from-config-datasource',
        '--to-schema',
        'prisma-finance/schema.prisma',
        '--exit-code',
      ],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          FINANCE_MIGRATE_DATABASE_URL: `${financeOwnerDatabaseUrl}?schema=finance`,
        },
        encoding: 'utf8',
      },
    );
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0); // 0 = empty diff, 2 = drift
  });
});
