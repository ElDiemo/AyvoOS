import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  ContractDraftDetail,
  ContractDraftFields,
  HotelAttribution,
  Portfolio,
  ProspectDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderContractPdf } from '../src/contracts/contract-pdf.js';
import { contractDocument } from '../src/contracts/contract-template.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Sales commissions PR 1b — who gets the commission for a hotel, the terms bound to it and the
 * portfolio (doc 068 §3.2–§3.3, §4.2, §12). Real sign-in: an ADMIN and salespeople with the
 * SALES role only. A signed contract prefills the salesperson and the first paid month, which the
 * admin confirms (another month with a reason); an existing hotel is attributed by hand. The
 * attribution is valid from a month, a change of salesperson keeps the history and the start, the
 * bound terms version never changes with later terms, and a salesperson sees only their own
 * hotels. Synthetic data only; no amount anywhere.
 */
describe.skipIf(!hasDatabase)('hotel attribution and portfolio (Obchod → Provize)', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b' | 'c' | 'x', { id: string; cookie: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const tag = randomUUID().slice(0, 6);
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const card = (code: string) => `/api/admin/hotels/${code}/sales-attribution`;
  const attribute = (cookie: string, code: string, body: object) =>
    http()
      .post(card(code))
      .set('Cookie', cookie)
      .send({
        requestId: randomUUID(),
        expectedRevision: 0,
        source: 'MANUAL',
        reason: 'stávající hotel bez akvizice',
        confirm: true,
        ...body,
      });
  const portfolio = async (cookie: string, month: string, salesperson?: string) => {
    const res = await http()
      .get('/api/admin/sales/portfolio')
      .query(salesperson ? { month, salesperson } : { month })
      .set('Cookie', cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Portfolio;
  };
  const counts = async () => ({
    attributions: await t.prisma.salesHotelAttribution.count(),
    bindings: await t.prisma.salesHotelCommissionTerms.count(),
  });

  async function createUser(roles: string[], displayName: string, siteIds: string[] = []) {
    const email = unique('attr');
    const created = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({ email, displayName, roles, siteIds, warehouseCodes: [], reason: 'commissions' })
      .expect(201);
    return { id: (created.body as AdminUserDetail).id, cookie: await sessionCookie(t, email) };
  }

  async function terms(salespersonId: string, expectedVersion: number, rates: object) {
    const res = await http()
      .post('/api/admin/sales/commission-terms')
      .set('Cookie', admin)
      .send({
        requestId: randomUUID(),
        salespersonId,
        expectedVersion,
        reason: 'smlouva o obchodní spolupráci',
        confirm: true,
        ...rates,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function hotel(name: string) {
    const res = await http()
      .post('/api/admin/hotels')
      .set('Cookie', admin)
      .send({
        requestId: randomUUID(),
        name: `${name} ${tag}`,
        addressLine1: 'Hotelová 9',
        addressLine2: null,
        postalCode: '602 00',
        city: 'Brno',
        countryCode: 'CZ',
        contactName: 'Recepce',
        contactPhone: '+420 500 000 068',
        contactEmail: 'recepce@provize.test',
        fulfillmentSiteId: INITIAL_SITE_ID,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { code: string; name: string };
  }

  const fields = (hotelName: string, startOn: string): ContractDraftFields => ({
    counterpartyName: `Hotelová společnost ${tag} s.r.o.`,
    counterpartyCompanyId: '12345678',
    counterpartyAddress: 'Ukázková 1, 602 00 Brno',
    representativeName: 'Jana Ukázková',
    representativeRole: 'jednatelka',
    hotelName,
    hotelAddress: 'Hotelová 9, 602 00 Brno',
    rooms: 40,
    pricePerRoomMonth: '120.50',
    currency: 'CZK',
    startOn,
    billingTiming: 'ARREARS',
    paymentTermsDays: 14,
    holders: 'NONE',
    holdersOwnership: null,
  });

  /** A prospect of `owner`, a draft of it linked to the hotel, and (optionally) its signed original. */
  async function contract(
    owner: { cookie: string },
    h: { code: string; name: string },
    startOn: string,
    sign = true,
  ) {
    const p = await http()
      .post('/api/admin/sales/prospects')
      .set('Cookie', owner.cookie)
      .send({
        requestId: randomUUID(),
        name: `Akvizice ${h.name}`,
        countryCode: 'CZ',
        city: 'Brno',
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        roomsEstimate: 40,
        accommodationType: 'HOTEL',
        website: null,
        source: null,
        priority: null,
        note: null,
        ownerId: null,
        contact: null,
        acknowledgeDuplicates: true,
      });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const f = fields(h.name, startOn);
    const created = await http()
      .post('/api/admin/contracts/drafts')
      .set('Cookie', admin)
      .send({
        requestId: randomUUID(),
        prospectCode: (p.body as ProspectDetail).code,
        hotelCode: h.code,
        fields: f,
        acknowledgeHotelMismatch: true,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const d = created.body as ContractDraftDetail;
    if (sign) {
      const pdf = await renderContractPdf(
        contractDocument('cs-b2b-1', {
          code: d.code,
          revision: 1,
          savedOn: '2027-04-01',
          fields: f,
        }),
      );
      let req = http().post(`/api/admin/contracts/drafts/${d.code}/signed`).set('Cookie', admin);
      for (const [k, v] of Object.entries({
        requestId: randomUUID(),
        expectedVersion: String(d.version),
        revision: '1',
        signedOn: '2027-04-10',
        confirm: 'true',
      }))
        req = req.field(k, v);
      const signed = await req.attach('file', pdf, 'podepsana.pdf');
      expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    }
    return { draftCode: d.code, prospectCode: (p.body as ProspectDetail).code };
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('attr-admin'),
      displayName: 'Admin Přiřazení',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    people.a = await createUser(['SALES'], `Alena Fiktivní ${tag}`);
    people.b = await createUser(['SALES'], `Bohdan Smyšlený ${tag}`);
    people.c = await createUser(['SALES'], `Cyril Bezpodmínek ${tag}`);
    people.x = await createUser(['WAREHOUSE_OPERATOR'], `Xaver Sklad ${tag}`, [INITIAL_SITE_ID]);
    await terms(people.a.id, 0, { initialRate: '20', initialMonths: 24, maintenanceRate: '5' });
    await terms(people.b.id, 0, { initialRate: '10', initialMonths: 36, maintenanceRate: '3' });
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('a signed contract prefills the salesperson and the month; the admin confirms it', async () => {
    const h = await hotel('Hotel Smlouva');
    const c = await contract(people.a, h, '2027-06-01');
    const before = (await http().get(card(h.code)).set('Cookie', admin).expect(200))
      .body as HotelAttribution;
    expect(before).toMatchObject({ revision: 0, commissionStart: null, history: [] });
    expect(before.candidates).toEqual([
      expect.objectContaining({
        draftCode: c.draftCode,
        revision: 1,
        signedOn: '2027-04-10',
        startOn: '2027-06-01',
        prospectCode: c.prospectCode,
        prefilledSalesperson: { id: people.a.id, name: `Alena Fiktivní ${tag}` },
        prefilledMonth: '2027-06',
      }),
    ]);
    expect(before.salespeople.find((s) => s.id === people.a.id)?.validTerms).toMatchObject({
      termsVersion: 1,
      initialRate: '20.00',
    });

    const fromContract = {
      source: 'CONTRACT',
      contractDraftCode: c.draftCode,
      contractRevision: 1,
      salespersonId: people.a.id,
      commissionStart: '2027-06',
      reason: 'podepsaná smlouva',
    };
    const n = await counts();
    // Never without the explicit confirmation of the first paid month.
    const unconfirmed = await attribute(admin, h.code, fromContract);
    expect([unconfirmed.status, unconfirmed.body.code]).toEqual([
      422,
      'COMMISSION_START_NOT_CONFIRMED',
    ]);
    expect(await counts()).toEqual(n);

    const ok = await attribute(admin, h.code, { ...fromContract, confirmCommissionStart: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = ok.body as HotelAttribution;
    expect(after).toMatchObject({ revision: 1, commissionStart: '2027-06' });
    expect(after.history[0]).toMatchObject({
      revision: 1,
      effectiveFrom: '2027-06',
      salesperson: { id: people.a.id },
      source: 'CONTRACT',
      contract: { draftCode: c.draftCode, revision: 1, startOn: '2027-06-01' },
      prospectCode: c.prospectCode,
      prefilledSalesperson: { id: people.a.id },
      startDiffersFromContract: false,
      binding: {
        termsVersion: 1,
        initialRate: '20.00',
        initialMonths: 24,
        maintenanceRate: '5.00',
      },
    });

    // The rate of commission months 1, 24 and 25 (the boundary of plan A).
    const at = async (month: string) =>
      (await portfolio(people.a.cookie, month)).rows.find((r) => r.hotel.code === h.code);
    expect(await at('2027-05')).toBeUndefined();
    expect(await at('2027-06')).toMatchObject({ k: 1, state: 'INITIAL', rate: '20.00' });
    expect(await at('2029-05')).toMatchObject({ k: 24, state: 'INITIAL', rate: '20.00' });
    expect(await at('2029-06')).toMatchObject({ k: 25, state: 'MAINTENANCE', rate: '5.00' });
  });

  it('another first paid month than the contract’s start is kept next to its reason', async () => {
    const h = await hotel('Hotel Jiný Měsíc');
    const c = await contract(people.b, h, '2027-06-15');
    const res = await attribute(admin, h.code, {
      source: 'CONTRACT',
      contractDraftCode: c.draftCode,
      contractRevision: 1,
      salespersonId: people.b.id,
      commissionStart: '2027-08',
      confirmCommissionStart: true,
      reason: 'červen a červenec zkušební provoz zdarma (dodatek)',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as HotelAttribution).history[0]).toMatchObject({
      commissionStart: '2027-08',
      contract: { startOn: '2027-06-15' },
      startDiffersFromContract: true,
      reason: 'červen a červenec zkušební provoz zdarma (dodatek)',
      binding: { termsVersion: 1, initialRate: '10.00', initialMonths: 36 },
    });
  });

  it('an unsigned revision or another hotel’s contract is refused; nothing is written', async () => {
    const h = await hotel('Hotel Bez Podpisu');
    const other = await hotel('Hotel Cizí');
    const unsigned = await contract(people.a, h, '2027-06-01', false);
    const foreign = await contract(people.a, other, '2027-06-01');
    const n = await counts();
    const base = {
      source: 'CONTRACT',
      contractRevision: 1,
      salespersonId: people.a.id,
      commissionStart: '2027-06',
      confirmCommissionStart: true,
    };
    const a = await attribute(admin, h.code, { ...base, contractDraftCode: unsigned.draftCode });
    expect([a.status, a.body.code]).toEqual([422, 'CONTRACT_NOT_SIGNED']);
    const b = await attribute(admin, h.code, { ...base, contractDraftCode: foreign.draftCode });
    expect([b.status, b.body.code]).toEqual([422, 'CONTRACT_OTHER_HOTEL']);
    expect((await http().get(card(h.code)).set('Cookie', admin)).body.candidates).toEqual([]);
    expect(await counts()).toEqual(n);
    // The database refuses the same, also past the service.
    const [row] = await t.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "hotels" WHERE "code" = ${h.code}`;
    const [draft] = await t.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "contract_drafts" WHERE "code" = ${foreign.draftCode}`;
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`INSERT INTO "sales_hotel_attributions"
          ("hotel_id", "revision", "effective_from", "salesperson_id", "source", "contract_draft_id",
           "contract_revision", "commission_start", "contract_start_on", "reason", "recorded_by", "request_id")
          VALUES (${row!.id}::uuid, 1, '2027-06-01', ${people.a.id}::uuid, 'CONTRACT', ${draft!.id}::uuid,
                  1, '2027-06-01', '2027-06-01', 'x', ${adminId}::uuid, ${randomUUID()}::uuid)`,
      ),
    ).rejects.toThrow(/signed draft of this hotel/);
  });

  it('an existing hotel without an acquisition is attributed by hand with an entered month', async () => {
    const h = await hotel('Hotel Stávající');
    const n = await counts();
    const noMonth = await attribute(admin, h.code, {
      salespersonId: people.a.id,
      confirmCommissionStart: true,
    });
    expect([noMonth.status, noMonth.body.code]).toEqual([422, 'COMMISSION_START_REQUIRED']);
    const withContract = await attribute(admin, h.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-01',
      confirmCommissionStart: true,
      contractDraftCode: 'SN-000001',
      contractRevision: 1,
    });
    expect([withContract.status, withContract.body.code]).toEqual([422, 'SOURCE_INVALID']);
    expect(await counts()).toEqual(n);
    const ok = await attribute(admin, h.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-01',
      confirmCommissionStart: true,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((ok.body as HotelAttribution).history[0]).toMatchObject({
      source: 'MANUAL',
      contract: null,
      prospectCode: null,
      prefilledSalesperson: null,
      commissionStart: '2027-01',
      effectiveFrom: '2027-01',
    });
  });

  it('a change of salesperson is valid from its month and keeps the history and the start', async () => {
    const h = await hotel('Hotel Předání');
    await attribute(admin, h.code, {
      salespersonId: people.a.id,
      commissionStart: '2028-01',
      confirmCommissionStart: true,
    }).expect(201);
    const change = (body: object) =>
      attribute(admin, h.code, {
        expectedRevision: 1,
        salespersonId: people.b.id,
        reason: 'předání portfolia',
        ...body,
      });
    const moved = await change({ effectiveFrom: '2028-04', commissionStart: '2028-02' });
    expect([moved.status, moved.body.code]).toEqual([422, 'COMMISSION_START_FIXED']);
    const early = await change({ effectiveFrom: '2027-12' });
    expect([early.status, early.body.code]).toEqual([422, 'EFFECTIVE_FROM_BEFORE_START']);
    const none = await change({});
    expect([none.status, none.body.code]).toEqual([422, 'EFFECTIVE_FROM_INVALID']);

    const ok = await change({ effectiveFrom: '2028-04' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = ok.body as HotelAttribution;
    expect(after.commissionStart).toBe('2028-01');
    expect(after.history.map((r) => [r.revision, r.effectiveFrom, r.salesperson?.id])).toEqual([
      [2, '2028-04', people.b.id],
      [1, '2028-01', people.a.id],
    ]);
    // B's own snapshot from April, at the hotel's current k (the start never moves).
    expect(after.history[0]!.binding).toMatchObject({ termsVersion: 1, initialRate: '10.00' });

    const row = (p: Portfolio) => p.rows.find((r) => r.hotel.code === h.code);
    expect(row(await portfolio(people.a.cookie, '2028-03'))).toMatchObject({ k: 3, rate: '20.00' });
    expect(row(await portfolio(people.b.cookie, '2028-03'))).toBeUndefined();
    expect(row(await portfolio(people.a.cookie, '2028-04'))).toBeUndefined();
    expect(row(await portfolio(people.b.cookie, '2028-04'))).toMatchObject({
      k: 4,
      since: '2028-04',
      commissionStart: '2028-01',
      rate: '10.00',
    });

    // History is append-only and the start never moves — also past the service.
    const [hid] = await t.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "hotels" WHERE "code" = ${h.code}`;
    for (const sql of [
      `UPDATE "sales_hotel_attributions" SET "reason" = 'x' WHERE "hotel_id" = '${hid!.id}'`,
      `DELETE FROM "sales_hotel_attributions" WHERE "hotel_id" = '${hid!.id}'`,
      `TRUNCATE "sales_hotel_attributions" CASCADE`,
      `UPDATE "sales_hotel_commission_terms" SET "initial_rate" = 30 WHERE "hotel_id" = '${hid!.id}'`,
      `DELETE FROM "sales_hotel_commission_terms" WHERE "hotel_id" = '${hid!.id}'`,
      `TRUNCATE "sales_hotel_commission_terms"`,
    ])
      await expect(
        withPrivileged((db) => db.$executeRawUnsafe(sql)),
        sql,
      ).rejects.toThrow();
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`INSERT INTO "sales_hotel_attributions"
          ("hotel_id", "revision", "effective_from", "salesperson_id", "source", "commission_start",
           "reason", "recorded_by", "request_id")
          VALUES (${hid!.id}::uuid, 3, '2028-06-01', ${people.a.id}::uuid, 'MANUAL', '2028-02-01',
                  'x', ${adminId}::uuid, ${randomUUID()}::uuid)`,
      ),
    ).rejects.toThrow(/never moves/);
    expect(await t.prisma.salesHotelAttribution.count({ where: { hotelId: hid!.id } })).toBe(2);
  });

  it('a new terms version binds only hotels attributed after it; the snapshot stays', async () => {
    const x = await hotel('Hotel Před Verzí');
    await attribute(admin, x.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-03',
      confirmCommissionStart: true,
    }).expect(201);
    await terms(people.a.id, 1, { initialRate: '15', initialMonths: 12, maintenanceRate: '4' });
    const y = await hotel('Hotel Po Verzi');
    const yRes = await attribute(admin, y.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-03',
      confirmCommissionStart: true,
    });
    expect((yRes.body as HotelAttribution).history[0]!.binding).toMatchObject({
      termsVersion: 2,
      initialRate: '15.00',
      initialMonths: 12,
    });
    const xNow = (await http().get(card(x.code)).set('Cookie', admin)).body as HotelAttribution;
    expect(xNow.history[0]!.binding).toMatchObject({ termsVersion: 1, initialRate: '20.00' });
    // Month 13 of both: X keeps v1 (still initial), Y is past v2's 12 months.
    const p = await portfolio(people.a.cookie, '2028-03');
    expect(p.rows.find((r) => r.hotel.code === x.code)).toMatchObject({
      k: 13,
      state: 'INITIAL',
      rate: '20.00',
      termsVersion: 1,
    });
    expect(p.rows.find((r) => r.hotel.code === y.code)).toMatchObject({
      k: 13,
      state: 'MAINTENANCE',
      rate: '4.00',
      termsVersion: 2,
    });
    // The DB refuses a snapshot that is not the salesperson's valid version (here v1 after v2),
    // or that differs from it — in one transaction with a fresh revision, so nothing stays.
    const [v1, v2] = await t.prisma.salesCommissionTerms.findMany({
      where: { salespersonId: people.a.id },
      orderBy: { version: 'asc' },
    });
    const [yid] = await t.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "hotels" WHERE "code" = ${y.code}`;
    const bind = (termsId: string, initialRate: number) =>
      withPrivileged((db) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "sales_hotel_attributions"
            ("hotel_id", "revision", "effective_from", "salesperson_id", "source", "commission_start",
             "reason", "recorded_by", "request_id")
            VALUES (${yid!.id}::uuid, 2, '2027-05-01', ${people.a.id}::uuid, 'MANUAL', '2027-03-01',
                    'x', ${adminId}::uuid, ${randomUUID()}::uuid)`;
          await tx.$executeRaw`INSERT INTO "sales_hotel_commission_terms"
            ("hotel_id", "attribution_revision", "binding_no", "kind", "effective_from", "terms_id",
             "initial_rate", "initial_months", "maintenance_rate")
            VALUES (${yid!.id}::uuid, 2, 1, 'ON_ATTRIBUTION', '2027-05-01', ${termsId}::uuid,
                    ${initialRate}, 12, 4)`;
        }),
      );
    await expect(bind(v1!.id, 20)).rejects.toThrow(/snapshot of its salesperson/);
    await expect(bind(v2!.id, 25)).rejects.toThrow(/snapshot of its salesperson/);
    expect(await t.prisma.salesHotelAttribution.count({ where: { hotelId: yid!.id } })).toBe(1);
  });

  it('missing terms bind nothing; an ineligible salesperson is refused', async () => {
    const h = await hotel('Hotel Bez Podmínek');
    const n = await counts();
    for (const id of [people.x.id, randomUUID()]) {
      const r = await attribute(admin, h.code, {
        salespersonId: id,
        commissionStart: '2027-05',
        confirmCommissionStart: true,
      });
      expect([r.status, r.body.code]).toEqual([422, 'SALESPERSON_NOT_ELIGIBLE']);
    }
    expect(await counts()).toEqual(n);
    const ok = await attribute(admin, h.code, {
      salespersonId: people.c.id,
      commissionStart: '2027-05',
      confirmCommissionStart: true,
    });
    expect((ok.body as HotelAttribution).history[0]!.binding).toBeNull();
    expect(await counts()).toEqual({ attributions: n.attributions + 1, bindings: n.bindings });
    const row = (await portfolio(people.c.cookie, '2027-05')).rows.find(
      (r) => r.hotel.code === h.code,
    );
    expect(row).toMatchObject({ state: 'MISSING_TERMS', rate: null, termsVersion: null });
  });

  it('a salesperson sees only their own hotels and never the hotel card routes', async () => {
    const month = '2028-04';
    const own = await portfolio(people.b.cookie, month);
    expect(own.totals).toBeNull();
    expect(own.rows.length).toBeGreaterThan(0);
    expect(own.rows.every((r) => r.salesperson?.id === people.b.id)).toBe(true);
    // Code, name, city and the own commission data — nothing else of the hotel register.
    expect(Object.keys(own.rows[0]!).sort()).toEqual(
      [
        'commissionStart',
        'contractDraftCode',
        'hotel',
        'k',
        'rate',
        'salesperson',
        'since',
        'source',
        'state',
        'termsVersion',
      ].sort(),
    );
    expect(Object.keys(own.rows[0]!.hotel).sort()).toEqual(['city', 'code', 'name']);
    const a = await portfolio(people.a.cookie, month);
    expect(a.rows.some((r) => own.rows.some((o) => o.hotel.code === r.hotel.code))).toBe(false);

    await http()
      .get('/api/admin/sales/portfolio')
      .query({ month, salesperson: people.a.id })
      .set('Cookie', people.b.cookie)
      .expect(403);
    await http()
      .get('/api/admin/sales/portfolio')
      .query({ month })
      .set('Cookie', people.x.cookie)
      .expect(403);
    const code = own.rows[0]!.hotel.code;
    await http().get(card(code)).set('Cookie', people.b.cookie).expect(403);
    await attribute(people.b.cookie, code, {
      expectedRevision: 2,
      effectiveFrom: '2028-05',
      salespersonId: people.b.id,
    }).expect(403);
    for (const method of ['put', 'patch', 'delete'] as const)
      expect((await http()[method](card(code)).set('Cookie', admin).send({})).status, method).toBe(
        404,
      );

    // The manager: everyone, a count per salesperson, and one person on request.
    const all = await portfolio(admin, month);
    expect(all.totals?.find((x) => x.salesperson?.id === people.b.id)?.hotels).toBe(
      own.rows.length,
    );
    const onlyA = await portfolio(admin, month, people.a.id);
    expect(onlyA.rows.map((r) => r.hotel.code).sort()).toEqual(
      a.rows.map((r) => r.hotel.code).sort(),
    );
  });

  it('a sales lead (custom role) sees the hotels but never another person’s rates', async () => {
    const code = `LEAD_${randomUUID().slice(0, 4).toUpperCase()}`;
    await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code,
        name: 'Vedoucí obchodu',
        description: '',
        permissions: ['sales:work', 'sales:manage', 'hotels:read'],
        reason: 'sales lead',
      })
      .expect(201);
    const lead = await createUser(['SALES', code], `Vedoucí Obchodu ${tag}`);
    const p = await portfolio(lead.cookie, '2028-04', people.b.id);
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.rows.every((r) => r.rate === null && r.state === 'INITIAL')).toBe(true);
    const h = (await http().get(card(p.rows[0]!.hotel.code)).set('Cookie', lead.cookie).expect(200))
      .body as HotelAttribution;
    expect(h.history[0]!.binding).toEqual({
      termsVersion: 1,
      initialRate: null,
      initialMonths: null,
      maintenanceRate: null,
    });
    expect(h.salespeople.find((x) => x.id === people.b.id)?.validTerms?.initialRate).toBeNull();
  });

  it('two admins at once: one revision, one 409; a replay returns the same', async () => {
    const h = await hotel('Hotel Souběh');
    const body = (requestId: string) => ({
      requestId,
      salespersonId: people.a.id,
      commissionStart: '2027-09',
      confirmCommissionStart: true,
    });
    const [r1, r2] = await Promise.all([
      attribute(admin, h.code, body(randomUUID())),
      attribute(admin, h.code, body(randomUUID())),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.code).toBe('CONCURRENT_CHANGE');
    const id = randomUUID();
    const first = await attribute(admin, h.code, {
      ...body(id),
      expectedRevision: 1,
      effectiveFrom: '2027-10',
      salespersonId: null,
      commissionStart: undefined,
      confirmCommissionStart: undefined,
      reason: 'hotel převzala centrála',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await attribute(admin, h.code, {
      ...body(id),
      expectedRevision: 1,
      effectiveFrom: '2027-10',
      salespersonId: null,
      commissionStart: undefined,
      confirmCommissionStart: undefined,
      reason: 'hotel převzala centrála',
    });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((first.body as HotelAttribution).history[0]).toMatchObject({
      revision: 2,
      salesperson: null,
      binding: null,
    });
    const row = (await portfolio(admin, '2027-10')).rows.find((r) => r.hotel.code === h.code);
    expect(row).toMatchObject({ salesperson: null, state: 'NO_SALESPERSON', rate: null });
  });
});
