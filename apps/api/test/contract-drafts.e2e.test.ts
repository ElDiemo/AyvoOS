import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  ContractDraftDetail,
  ContractDraftFields,
  ContractDraftPrefill,
  ContractDraftSummary,
  ProspectDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractDocument, holdersText } from '../src/contracts/contract-template.js';
import { openPdf, pageText } from './support/pdf-inspect.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Contract drafts (ADR 0043, doc 045) through the real sign-in: written only by an explicit save,
 * at a prospect (Obchod's scope) or a hotel (sales:manage + hotels:read); the three holder
 * combinations and the refused mismatch (also in the DB); another salesperson's draft is 404;
 * revisions from the version seen; removal confirmed and restorable; a hotel linked only by hand;
 * the PDF from the saved revision with the draft mark; nothing created by a hotel, a won prospect
 * or anything else. Synthetic data only.
 */
describe.skipIf(!hasDatabase)('contract drafts', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b', { id: string; cookie: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const tag = randomUUID().slice(0, 6);
  const D = '/api/admin/contracts/drafts';
  const get = (cookie: string, path: string) => http().get(`${D}${path}`).set('Cookie', cookie);
  const post = (cookie: string, path: string, body: object) =>
    http()
      .post(`${D}${path}`)
      .set('Cookie', cookie)
      .send({ requestId: randomUUID(), ...body });

  const fields = (over: Partial<ContractDraftFields> = {}): ContractDraftFields => ({
    counterpartyName: `Hotelová společnost ${tag} s.r.o.`,
    counterpartyCompanyId: '12345678',
    counterpartyAddress: 'Ukázková 1, 602 00 Brno',
    representativeName: 'Jana Ukázková',
    representativeRole: 'jednatelka',
    hotelName: `Hotel Návrh ${tag}`,
    hotelAddress: 'Hotelová 2, 602 00 Brno',
    rooms: 40,
    pricePerRoomMonth: '120.50',
    currency: 'CZK',
    startOn: '2027-01-01',
    billingTiming: 'ARREARS',
    paymentTermsDays: 14,
    holders: 'NONE',
    holdersOwnership: null,
    ...over,
  });
  const counts = async () => ({
    drafts: await t.prisma.contractDraft.count(),
    revisions: await t.prisma.contractDraftRevision.count(),
    hotels: await t.prisma.hotel.count(),
  });
  async function prospect(cookie: string, name: string) {
    const res = await http().post('/api/admin/sales/prospects').set('Cookie', cookie).send({
      requestId: randomUUID(),
      name,
      countryCode: 'CZ',
      city: 'Brno',
      addressLine1: 'Akviziční 3',
      addressLine2: null,
      postalCode: '602 00',
      roomsEstimate: 55,
      accommodationType: 'HOTEL',
      website: null,
      source: null,
      priority: null,
      note: null,
      ownerId: null,
      contact: null,
      acknowledgeDuplicates: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ProspectDetail;
  }
  async function hotel(name: string) {
    const res = await http().post('/api/admin/hotels').set('Cookie', admin).send({
      requestId: randomUUID(),
      name,
      addressLine1: 'Hotelová 9',
      addressLine2: null,
      postalCode: '602 00',
      city: 'Brno',
      countryCode: 'CZ',
      contactName: 'Recepce',
      contactPhone: '+420 500 000 046',
      contactEmail: 'recepce@navrh.test',
      fulfillmentSiteId: INITIAL_SITE_ID,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { code: string };
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('contracts-admin'),
      displayName: 'Admin Smluv',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    for (const key of ['a', 'b'] as const) {
      const email = unique(`contracts-${key}`);
      const created = await http()
        .post('/api/admin/identity/users')
        .set('Cookie', admin)
        .send({
          email,
          displayName: `Obchodník ${key}`,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'salesperson',
        })
        .expect(201);
      people[key] = {
        id: (created.body as AdminUserDetail).id,
        cookie: await sessionCookie(t, email),
      };
    }
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('nothing is created by itself: a hotel, a won prospect, a prefill write no draft', async () => {
    const before = await counts();
    const p = await prospect(people.a.cookie, `Akvizice Bez Návrhu ${tag}`);
    await hotel(`Hotel Bez Návrhu ${tag}`);
    await http()
      .post(`/api/admin/sales/prospects/${p.code}/stage`)
      .set('Cookie', people.a.cookie)
      .send({
        requestId: randomUUID(),
        revision: p.revision,
        stage: 'WON',
        reason: null,
        lostReason: null,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const prefill = (await get(people.a.cookie, `/prefill?prospect=${p.code}`).expect(200))
      .body as ContractDraftPrefill;
    // The prospect's own data to start from; hotels only for sales:manage + hotels:read.
    expect(prefill.fields).toMatchObject({
      hotelName: `Akvizice Bez Návrhu ${tag}`,
      hotelAddress: 'Akviziční 3, 602 00 Brno',
      rooms: 55,
      counterpartyName: null,
    });
    expect(prefill.hotels).toEqual([]);
    const after = await counts();
    expect(after.drafts).toBe(before.drafts);
    expect(after.revisions).toBe(before.revisions);
    expect((await get(people.a.cookie, `?prospect=${p.code}`).expect(200)).body).toEqual([]);
  });

  it('the three holder combinations are saved; a mismatch is refused by the API and the DB', async () => {
    const p = await prospect(people.a.cookie, `Akvizice Držáky ${tag}`);
    const combos = [
      { holders: 'NONE', holdersOwnership: null },
      { holders: 'WITH', holdersOwnership: 'AYVO' },
      { holders: 'WITH', holdersOwnership: 'CUSTOMER' },
    ] as const;
    for (const c of combos) {
      const res = await post(people.a.cookie, '', {
        prospectCode: p.code,
        hotelCode: null,
        fields: fields(c),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const d = res.body as ContractDraftDetail;
      expect(d.revisions[0]!.fields).toMatchObject(c);
      expect(d.events.map((e) => e.kind)).toEqual(['CREATED']);
      expect(d.prospect?.code).toBe(p.code);
    }
    const before = await counts();
    for (const bad of [
      { holders: 'NONE', holdersOwnership: 'AYVO' },
      { holders: 'WITH', holdersOwnership: null },
    ] as const) {
      const r = await post(people.a.cookie, '', {
        prospectCode: p.code,
        hotelCode: null,
        fields: fields(bad),
      });
      expect([r.status, r.body.code]).toEqual([422, 'HOLDERS_OWNERSHIP_MISMATCH']);
    }
    for (const bad of [
      { pricePerRoomMonth: '120.505' },
      { pricePerRoomMonth: '0' },
      { rooms: 0 },
      { holders: 'MAYBE' },
      { counterpartyName: '' },
    ])
      await post(people.a.cookie, '', {
        prospectCode: p.code,
        hotelCode: null,
        fields: { ...fields(), ...bad },
      }).expect(400);
    expect(await counts()).toEqual(before);
    // The same rules in the database, without the API.
    const draft = await t.prisma.contractDraft.findFirstOrThrow({ where: { prospectId: p.id } });
    const raw = (holders: string, ownership: string | null, price = '10') =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO contract_draft_revisions (draft_id, revision, template_version, counterparty_name,
           hotel_name, hotel_address, rooms, price_per_room_month, currency, start_on, billing_timing,
           payment_terms_days, holders, holders_ownership, reason, created_by, request_id)
         VALUES ('${draft.id}', 2, 'cs-b2b-1', 'x', 'x', 'x', 1, ${price}, 'CZK', '2027-01-01',
           'ARREARS', 14, '${holders}', ${ownership ? `'${ownership}'` : 'NULL'}, 'x',
           '${people.a.id}', '${randomUUID()}')`,
      );
    await expect(raw('NONE', 'AYVO')).rejects.toThrow();
    await expect(raw('WITH', null)).rejects.toThrow();
    await expect(raw('NONE', null, '10.123')).rejects.toThrow();
  });

  it("another salesperson's draft is never seen or changed (404); the list stays in scope", async () => {
    const p = await prospect(people.a.cookie, `Akvizice Cizí ${tag}`);
    const d = (
      await post(people.a.cookie, '', { prospectCode: p.code, hotelCode: null, fields: fields() })
    ).body as ContractDraftDetail;
    const b = people.b.cookie;
    await get(b, `/${d.code}`).expect(404);
    await get(b, `/${d.code}/revisions/1/pdf`).expect(404);
    await get(b, `?prospect=${p.code}`).expect(404);
    await get(b, `/prefill?prospect=${p.code}`).expect(404);
    await post(b, '', { prospectCode: p.code, hotelCode: null, fields: fields() }).expect(404);
    await post(b, `/${d.code}/revisions`, {
      expectedVersion: 1,
      reason: 'cizí',
      fields: fields(),
    }).expect(404);
    await post(b, `/${d.code}/remove`, { expectedVersion: 1, reason: 'x', confirm: true }).expect(
      404,
    );
    // Hotels are not a salesperson's: neither a hotel-only draft nor a link.
    const h = await hotel(`Hotel Obchodníka ${tag}`);
    const r = await post(people.a.cookie, '', {
      prospectCode: null,
      hotelCode: h.code,
      fields: fields(),
    });
    expect([r.status, r.body.code]).toEqual([403, 'HOTEL_LINK_FORBIDDEN']);
    await get(people.a.cookie, `?hotel=${h.code}`).expect(403);
    // sales:manage sees it (ADMIN).
    await get(admin, `/${d.code}`).expect(200);
  });

  it('edited from the version seen; removed with confirmation and restored; history kept', async () => {
    const p = await prospect(people.a.cookie, `Akvizice Úpravy ${tag}`);
    const a = people.a.cookie;
    let d = (await post(a, '', { prospectCode: p.code, hotelCode: null, fields: fields() }))
      .body as ContractDraftDetail;
    const revise = (over: object) =>
      post(a, `/${d.code}/revisions`, {
        expectedVersion: d.version,
        reason: 'Upřesnění po jednání (test)',
        fields: fields({ holders: 'WITH', holdersOwnership: 'CUSTOMER', rooms: 42 }),
        ...over,
      });
    const requestId = randomUUID();
    const first = await revise({ requestId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Replayed: the same answer, no third revision.
    expect((await revise({ requestId })).body).toEqual(first.body);
    const stale = await revise({});
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    d = first.body as ContractDraftDetail;
    expect(d.currentRevision).toBe(2);
    expect(d.revisions.map((r) => [r.revision, r.fields.rooms, r.reason])).toEqual([
      [2, 42, 'Upřesnění po jednání (test)'],
      [1, 40, null],
    ]);
    // Removing needs the confirmation and a reason.
    await post(a, `/${d.code}/remove`, { expectedVersion: d.version, reason: 'x' }).expect(400);
    await post(a, `/${d.code}/remove`, {
      expectedVersion: d.version,
      reason: '',
      confirm: true,
    }).expect(400);
    d = (
      await post(a, `/${d.code}/remove`, {
        expectedVersion: d.version,
        reason: 'Zadáno omylem (test)',
        confirm: true,
      }).expect(200)
    ).body as ContractDraftDetail;
    expect(d).toMatchObject({ removed: true, removeReason: 'Zadáno omylem (test)' });
    const blocked = await revise({ expectedVersion: d.version });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'CONTRACT_DRAFT_REMOVED']);
    // Still listed (as removed) and readable; restored by hand.
    expect(
      ((await get(a, `?prospect=${p.code}`).expect(200)).body as ContractDraftSummary[]).find(
        (x) => x.code === d.code,
      )?.removed,
    ).toBe(true);
    d = (
      await post(a, `/${d.code}/restore`, {
        expectedVersion: d.version,
        reason: 'Přece platí (test)',
        confirm: true,
      }).expect(200)
    ).body as ContractDraftDetail;
    expect(d.removed).toBe(false);
    expect(d.events.map((e) => e.kind)).toEqual(['RESTORED', 'REMOVED', 'REVISED', 'CREATED']);
    // Never deleted, revisions never changed — also for the database owner of the test.
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM contract_drafts WHERE code = '${d.code}'`),
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE contract_draft_revisions SET rooms = 1`),
    ).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM contract_draft_events`)).rejects.toThrow();
  });

  it('a hotel is linked only by hand (sales:manage + hotels:read); a hotel-only draft too', async () => {
    const p = await prospect(admin, `Akvizice Hotel ${tag}`);
    const h = await hotel(`Hotel Připojený ${tag}`);
    let d = (await post(admin, '', { prospectCode: p.code, hotelCode: null, fields: fields() }))
      .body as ContractDraftDetail;
    expect(d).toMatchObject({ hotel: null, canLinkHotel: true });
    // Before the explicit link the hotel has no draft.
    expect((await get(admin, `?hotel=${h.code}`).expect(200)).body).toEqual([]);
    d = (
      await post(admin, `/${d.code}/hotel`, {
        expectedVersion: d.version,
        hotelCode: h.code,
        reason: 'Akvizice se stala hotelem (test)',
      }).expect(200)
    ).body as ContractDraftDetail;
    expect(d.hotel?.code).toBe(h.code);
    expect(d.canLinkHotel).toBe(false);
    const again = await post(admin, `/${d.code}/hotel`, {
      expectedVersion: d.version,
      hotelCode: h.code,
      reason: 'znovu',
    });
    expect([again.status, again.body.code]).toEqual([409, 'HOTEL_ALREADY_LINKED']);
    const list = (await get(admin, `?hotel=${h.code}`).expect(200)).body as ContractDraftSummary[];
    expect(list.map((x) => x.code)).toEqual([d.code]);
    // From the hotel's card: prefilled from the hotel, written only by the save.
    const prefill = (await get(admin, `/prefill?hotel=${h.code}`).expect(200))
      .body as ContractDraftPrefill;
    expect(prefill.fields).toMatchObject({
      hotelName: `Hotel Připojený ${tag}`,
      hotelAddress: 'Hotelová 9, 602 00 Brno',
    });
    expect(prefill.hotels.some((x) => x.code === h.code)).toBe(true);
    const only = await post(admin, '', { prospectCode: null, hotelCode: h.code, fields: fields() });
    expect(only.status).toBe(201);
    expect((only.body as ContractDraftDetail).prospect).toBeNull();
    // A missing hotel is refused, never created.
    const hotels = await t.prisma.hotel.count();
    const missing = await post(admin, '', {
      prospectCode: null,
      hotelCode: 'HT-999999',
      fields: fields(),
    });
    expect([missing.status, missing.body.code]).toEqual([422, 'HOTEL_NOT_FOUND']);
    expect(await t.prisma.hotel.count()).toBe(hotels);
  });

  it('the PDF of a saved revision: the draft mark, the entered values, the holder variant', async () => {
    const p = await prospect(people.a.cookie, `Akvizice PDF ${tag}`);
    const d = (
      await post(people.a.cookie, '', {
        prospectCode: p.code,
        hotelCode: null,
        fields: fields({
          holders: 'WITH',
          holdersOwnership: 'AYVO',
          counterpartyCompanyId: null,
          pricePerRoomMonth: '1500.5',
        }),
      })
    ).body as ContractDraftDetail;
    const res = await get(people.a.cookie, `/${d.code}/revisions/1/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${d.code}-r1-NAVRH.pdf`);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await openPdf(body);
    expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(210, 0);
    let text = '';
    for (let i = 1; i <= pdf.pageCount; i++) {
      const page = await pageText(pdf, i);
      expect(page).toContain('NÁVRH – K PRÁVNÍ KONTROLE');
      text += page;
    }
    for (const s of [
      `Hotelová společnost ${tag} s.r.o.`,
      '1 500,50 CZK',
      'bez DPH',
      'Držáky zůstávají ve vlastnictví AYVO',
      'pracovní text k právní kontrole',
      'identifikace dodavatele – doplní právní kontrola',
    ])
      expect(text.replace(/\s+/g, ' ')).toContain(s.replaceAll('\u00a0', ' '));
    const events = ((await get(people.a.cookie, `/${d.code}`)).body as ContractDraftDetail).events;
    expect(events.map((e) => e.kind)).toEqual(['PDF_DOWNLOADED', 'CREATED']);
    await get(people.a.cookie, `/${d.code}/revisions/9/pdf`).expect(404);
  });
});

describe('the working template (cs-b2b-1)', () => {
  const base = {
    code: 'SN-000001',
    revision: 1,
    savedOn: '2026-11-03',
  };
  it('each holder variant has its own marked working text; nothing binding is invented', () => {
    expect(holdersText({ holders: 'NONE', holdersOwnership: null }).join(' ')).toContain(
      'nejsou držáky',
    );
    expect(holdersText({ holders: 'WITH', holdersOwnership: 'AYVO' }).join(' ')).toContain(
      'zůstávají ve vlastnictví AYVO',
    );
    const customer = holdersText({ holders: 'WITH', holdersOwnership: 'CUSTOMER' }).join(' ');
    expect(customer).toContain('přejdou do vlastnictví zákazníka');
    expect(customer).toContain('doplní právní kontrola');
    for (const v of [
      { holders: 'NONE', holdersOwnership: null },
      { holders: 'WITH', holdersOwnership: 'AYVO' },
      { holders: 'WITH', holdersOwnership: 'CUSTOMER' },
    ] as const)
      expect(holdersText(v)[0]).toMatch(/^\[pracovní text k právní kontrole\]/);
  });
  it('missing optional party data stay blank lines to complete by hand', () => {
    const doc = contractDocument({
      ...base,
      fields: {
        counterpartyName: 'Firma',
        counterpartyCompanyId: null,
        counterpartyAddress: null,
        representativeName: null,
        representativeRole: null,
        hotelName: 'Hotel',
        hotelAddress: 'Adresa',
        rooms: 1,
        pricePerRoomMonth: '10.00',
        currency: 'EUR',
        startOn: '2027-01-01',
        billingTiming: 'ADVANCE',
        paymentTermsDays: 0,
        holders: 'NONE',
        holdersOwnership: null,
      },
    });
    const parties = doc.sections[0]!.paragraphs.join('\n');
    expect(parties).toContain('IČO: ……');
    expect(parties).toContain('Zastoupen: ……');
    expect(doc.sections[2]!.paragraphs).toContain('Fakturace: předem');
  });
});
