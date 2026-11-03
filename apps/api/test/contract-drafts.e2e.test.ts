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
import {
  CONTRACT_TEMPLATES,
  contractDocument,
  holdersText,
  UnknownContractTemplate,
  type TemplateInput,
} from '../src/contracts/contract-template.js';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderContractPdf } from '../src/contracts/contract-pdf.js';
import { InvalidSignedPdf, inspectSignedPdf } from '../src/contracts/signed-pdf.js';
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

  it('a hotel is linked by hand; another hotel than the draft names is never linked unobserved; a wrong link is corrected with an audit', async () => {
    const p = await prospect(admin, `Akvizice Hotel ${tag}`);
    const right = await hotel(`Hotel Připojený ${tag}`);
    const other = await hotel(`Hotel Jiný ${tag}`);
    // The draft names the hotel exactly as its record (address "Hotelová 9, 602 00 Brno").
    const named = fields({
      hotelName: `hotel připojený ${tag}`,
      hotelAddress: 'Hotelová 9,  602 00 Brno',
    });
    let d = (await post(admin, '', { prospectCode: p.code, hotelCode: null, fields: named }))
      .body as ContractDraftDetail;
    expect(d).toMatchObject({ hotel: null, canLinkHotel: true, hotelMismatch: false });
    expect((await get(admin, `?hotel=${right.code}`).expect(200)).body).toEqual([]);
    const link = (hotelCode: string, over: object = {}) =>
      post(admin, `/${d.code}/hotel`, {
        expectedVersion: d.version,
        hotelCode,
        reason: 'Akvizice se stala hotelem (test)',
        ...over,
      });
    // Wrongly the other hotel: refused, naming both identities; nothing changes.
    const refused = await link(other.code);
    expect([refused.status, refused.body.code]).toEqual([409, 'HOTEL_IDENTITY_MISMATCH']);
    expect(refused.body.details).toMatchObject({
      draft: { name: `hotel připojený ${tag}` },
      hotel: { code: other.code, name: `Hotel Jiný ${tag}`, address: 'Hotelová 9, 602 00 Brno' },
    });
    expect(((await get(admin, `/${d.code}`)).body as ContractDraftDetail).hotel).toBeNull();
    // Knowingly anyway (acknowledged): linked, the page shows the mismatch.
    d = (await link(other.code, { acknowledgeMismatch: true }).expect(200))
      .body as ContractDraftDetail;
    expect(d).toMatchObject({ hotel: { code: other.code }, hotelMismatch: true });
    // The same hotel again: nothing to do.
    const again = await link(other.code, { acknowledgeMismatch: true });
    expect([again.status, again.body.code]).toEqual([409, 'HOTEL_ALREADY_LINKED']);
    // The correction of the wrong link: to the hotel the draft names (case/spacing ignored).
    d = (await link(right.code, { reason: 'Oprava chybné vazby (test)' }).expect(200))
      .body as ContractDraftDetail;
    expect(d).toMatchObject({
      hotel: { code: right.code },
      hotelIdentity: { name: `Hotel Připojený ${tag}`, address: 'Hotelová 9, 602 00 Brno' },
      hotelMismatch: false,
    });
    expect(d.events.slice(0, 2).map((e) => [e.kind, e.reason])).toEqual([
      ['HOTEL_LINKED', 'Oprava chybné vazby (test)'],
      ['HOTEL_LINKED', 'Akvizice se stala hotelem (test)'],
    ]);
    const audit = await t.prisma.contractDraftEvent.findFirstOrThrow({
      where: { draft: { code: d.code }, kind: 'HOTEL_LINKED' },
      orderBy: { at: 'desc' },
    });
    expect(audit.details).toEqual({
      from: other.code,
      to: right.code,
      signedRevisions: [],
      mismatchAcknowledged: false,
    });
    expect(
      ((await get(admin, `?hotel=${right.code}`)).body as ContractDraftSummary[]).map(
        (x) => x.code,
      ),
    ).toEqual([d.code]);
    expect((await get(admin, `?hotel=${other.code}`)).body).toEqual([]);
    // An edit that names another hotel than the linked one: refused unless acknowledged.
    const edit = (over: object) =>
      post(admin, `/${d.code}/revisions`, {
        expectedVersion: d.version,
        reason: 'Jiný název hotelu (test)',
        fields: fields({ hotelName: 'Úplně jiný hotel' }),
        ...over,
      });
    const unobserved = await edit({});
    expect([unobserved.status, unobserved.body.code]).toEqual([409, 'HOTEL_IDENTITY_MISMATCH']);
    d = (await edit({ acknowledgeHotelMismatch: true }).expect(201)).body as ContractDraftDetail;
    expect(d.hotelMismatch).toBe(true);
    // Never unlinked, also in the database.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE contract_drafts SET hotel_id = NULL, version = version + 1 WHERE code = '${d.code}'`,
      ),
    ).rejects.toThrow();

    // From the hotel's card: prefilled from the hotel; a hotel-only draft as it names the hotel.
    const prefill = (await get(admin, `/prefill?hotel=${right.code}`).expect(200))
      .body as ContractDraftPrefill;
    expect(prefill.fields).toMatchObject({
      hotelName: `Hotel Připojený ${tag}`,
      hotelAddress: 'Hotelová 9, 602 00 Brno',
    });
    expect(prefill.hotels.find((x) => x.code === right.code)).toEqual({
      code: right.code,
      name: `Hotel Připojený ${tag}`,
      address: 'Hotelová 9, 602 00 Brno',
    });
    const asHotel = fields({
      hotelName: prefill.fields.hotelName!,
      hotelAddress: prefill.fields.hotelAddress!,
    });
    const only = await post(admin, '', {
      prospectCode: null,
      hotelCode: right.code,
      fields: asHotel,
    });
    expect(only.status, JSON.stringify(only.body)).toBe(201);
    expect((only.body as ContractDraftDetail).prospect).toBeNull();
    const differs = await post(admin, '', {
      prospectCode: null,
      hotelCode: right.code,
      fields: fields(),
    });
    expect([differs.status, differs.body.code]).toEqual([409, 'HOTEL_IDENTITY_MISMATCH']);
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

  it('the signed original: uploaded by hand to the current revision, kept unchanged, locking the draft; concurrent with removal one wins', async () => {
    const p = await prospect(people.a.cookie, `Akvizice Podpis ${tag}`);
    const a = people.a.cookie;
    let d = (await post(a, '', { prospectCode: p.code, hotelCode: null, fields: fields() }))
      .body as ContractDraftDetail;
    expect(d).toMatchObject({ signed: [], canUploadSigned: true });
    // A real PDF with pages (as a scan or a signed export would be).
    const pdf = await renderContractPdf(
      contractDocument('cs-b2b-1', {
        code: d.code,
        revision: 1,
        savedOn: '2026-11-02',
        fields: fields(),
      }),
    );
    const upload = (over: Record<string, string> = {}, file: Buffer = pdf, cookie = a) => {
      const values = {
        requestId: randomUUID(),
        expectedVersion: String(d.version),
        revision: String(d.currentRevision),
        signedOn: '2026-11-02',
        confirm: 'true',
        ...over,
      };
      let req = http().post(`${D}/${d.code}/signed`).set('Cookie', cookie);
      for (const [k, v] of Object.entries(values)) req = req.field(k, v);
      return req.attach('file', file, 'Smlouva podepsaná.pdf');
    };
    const before = await t.prisma.contractSignedDocument.count();
    // Never kept for good: not a PDF, only a PDF header, a truncated upload (review SIGN122-R1).
    for (const bad of [
      Buffer.from('PNG? no'),
      Buffer.from(`%PDF-1.4\n% podepsaný originál ${tag}\n%%EOF\n`),
      pdf.subarray(0, Math.floor(pdf.length / 2)),
    ]) {
      const r = await upload({}, bad);
      expect([r.status, r.body.code]).toEqual([422, 'UNSUPPORTED_DOCUMENT']);
    }
    await upload({ confirm: 'false' }).expect(400);
    const stale = await upload({ expectedVersion: String(d.version + 5) });
    expect([stale.status, stale.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    await upload({}, pdf, people.b.cookie).expect(404);
    expect(await t.prisma.contractSignedDocument.count()).toBe(before);

    const requestId = randomUUID();
    const first = await upload({ requestId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Replayed: the same answer, one record (and one stored file).
    expect((await upload({ requestId })).body).toEqual(first.body);
    d = first.body as ContractDraftDetail;
    expect(d.signed).toMatchObject([
      {
        revision: 1,
        signedOn: '2026-11-02',
        originalFilename: 'Smlouva podepsan_.pdf',
        byteSize: pdf.length,
      },
    ]);
    expect(d.canUploadSigned).toBe(false);
    expect(await t.prisma.contractSignedDocument.count()).toBe(before + 1);

    // Downloaded exactly as uploaded, with the access check; recorded.
    const got = await get(a, `/${d.code}/signed/1`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(got.body as Buffer, pdf)).toBe(0);
    expect(got.headers['cache-control']).toContain('no-store');
    expect(got.headers['content-disposition']).toContain(`${d.code}-r1-PODEPSANO.pdf`);
    await get(people.b.cookie, `/${d.code}/signed/1`).expect(404);
    await get(a, `/${d.code}/signed/2`).expect(404);
    // A stored file changed behind the application is never handed out as the original.
    const stored = await t.prisma.contractSignedDocument.findFirstOrThrow({
      where: { revisionRow: { draft: { code: d.code } } },
    });
    const path = join(t.storage.directory, stored.storageKey);
    const kept = await readFile(path);
    await writeFile(path, Buffer.concat([kept, Buffer.from('\n% pozměněno\n')]));
    const changed = await get(a, `/${d.code}/signed/1`);
    expect([changed.status, changed.body.code]).toEqual([500, 'STORED_FILE_CHANGED']);
    await writeFile(path, kept);
    await get(a, `/${d.code}/signed/1`).expect(200);

    // Never replaced; the draft never removed; a change is a new revision (an amendment).
    const again = await upload();
    expect([again.status, again.body.code]).toEqual([409, 'CONTRACT_REVISION_SIGNED']);
    const remove = await post(a, `/${d.code}/remove`, {
      expectedVersion: d.version,
      reason: 'x',
      confirm: true,
    });
    expect([remove.status, remove.body.code]).toEqual([409, 'CONTRACT_DRAFT_SIGNED']);
    d = (
      await post(a, `/${d.code}/revisions`, {
        expectedVersion: d.version,
        reason: 'Dodatek po podpisu (test)',
        fields: fields({ rooms: 60 }),
      }).expect(201)
    ).body as ContractDraftDetail;
    expect(d).toMatchObject({ currentRevision: 2, canUploadSigned: true });
    expect(d.signed.map((x) => x.revision)).toEqual([1]);
    // A paper signed for revision 1 is never filed under revision 2.
    const old = await upload({ revision: '1' });
    expect([old.status, old.body.code]).toEqual([409, 'CONCURRENT_CHANGE']);
    // Two downloads served; the refused one (changed file) is not recorded as served.
    expect(d.events.map((e) => e.kind).slice(0, 4)).toEqual([
      'REVISED',
      'SIGNED_DOWNLOADED',
      'SIGNED_DOWNLOADED',
      'SIGNED_UPLOADED',
    ]);

    // The database holds it without the API.
    const signedRow = await t.prisma.contractSignedDocument.findFirstOrThrow({
      where: { revisionRow: { draft: { code: d.code } } },
    });
    for (const sql of [
      `UPDATE contract_signed_documents SET sha256 = repeat('0', 64) WHERE id = '${signedRow.id}'`,
      `DELETE FROM contract_signed_documents WHERE id = '${signedRow.id}'`,
      `UPDATE contract_drafts SET removed_at = now(), removed_by = created_by, remove_reason = 'x', version = version + 1 WHERE code = '${d.code}'`,
      `INSERT INTO contract_signed_documents (draft_id, revision, storage_key, sha256, byte_size, original_filename, signed_on, uploaded_by, request_id)
         VALUES ('${signedRow.draftId}', 1, 'contract-documents/2026/11/${randomUUID()}.pdf', repeat('a', 64), 1, 'x.pdf', '2026-11-02', '${people.a.id}', '${randomUUID()}')`,
    ])
      await expect(t.prisma.$executeRawUnsafe(sql)).rejects.toThrow();

    // Upload and removal at the same moment, from the same version: exactly one wins.
    const race = (await post(a, '', { prospectCode: p.code, hotelCode: null, fields: fields() }))
      .body as ContractDraftDetail;
    d = race;
    const [up, rm] = await Promise.all([
      upload(),
      post(a, `/${race.code}/remove`, {
        expectedVersion: race.version,
        reason: 'souběh',
        confirm: true,
      }),
    ]);
    const lost = [up, rm].filter((r) => r.status === 409);
    expect(lost.map((r) => r.body.code)).toEqual(['CONCURRENT_CHANGE']);
    expect([up, rm].filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
    const after = (await get(a, `/${race.code}`)).body as ContractDraftDetail;
    // Never both: signed and removed.
    expect(after.signed.length > 0 && after.removed).toBe(false);
    expect(after.signed.length > 0 || after.removed).toBe(true);
  });

  it('signed at a prospect without a hotel: the first link only to the hotel the signed revision names; then visible from the hotel; never changed after (SIGN122-R2)', async () => {
    const p = await prospect(admin, `Akvizice Podepsaná ${tag}`);
    const named = await hotel(`Hotel Podepsaný ${tag}`);
    const other = await hotel(`Hotel Cizí Podpis ${tag}`);
    let d = (
      await post(admin, '', {
        prospectCode: p.code,
        hotelCode: null,
        fields: fields({
          hotelName: `Hotel Podepsaný ${tag}`,
          hotelAddress: 'Hotelová 9, 602 00 Brno',
        }),
      })
    ).body as ContractDraftDetail;
    const pdf = await renderContractPdf(
      contractDocument('cs-b2b-1', {
        code: d.code,
        revision: 1,
        savedOn: '2026-11-02',
        fields: fields(),
      }),
    );
    d = (
      await http()
        .post(`${D}/${d.code}/signed`)
        .set('Cookie', admin)
        .field('requestId', randomUUID())
        .field('expectedVersion', String(d.version))
        .field('revision', '1')
        .field('signedOn', '2026-11-02')
        .field('confirm', 'true')
        .attach('file', pdf, 'podepsano.pdf')
        .expect(201)
    ).body as ContractDraftDetail;
    expect(d).toMatchObject({
      hotel: null,
      canLinkHotel: true,
      signedHotel: { name: `Hotel Podepsaný ${tag}`, address: 'Hotelová 9, 602 00 Brno' },
    });
    // An amendment naming another hotel does not change what the signed revision names.
    d = (
      await post(admin, `/${d.code}/revisions`, {
        expectedVersion: d.version,
        reason: 'Dodatek (test)',
        fields: fields({
          hotelName: `Hotel Cizí Podpis ${tag}`,
          hotelAddress: 'Hotelová 9, 602 00 Brno',
        }),
      }).expect(201)
    ).body as ContractDraftDetail;
    const link = (hotelCode: string, over: object = {}) =>
      post(admin, `/${d.code}/hotel`, {
        expectedVersion: d.version,
        hotelCode,
        reason: 'Akvizice je hotel (test)',
        ...over,
      });
    // Not the signed hotel: refused, even acknowledged (the amendment names it — irrelevant).
    for (const over of [{}, { acknowledgeMismatch: true }]) {
      const r = await link(other.code, over);
      expect([r.status, r.body.code]).toEqual([409, 'HOTEL_NOT_SIGNED_HOTEL']);
      expect(r.body.details).toMatchObject({ signedRevision: 1, hotel: { code: other.code } });
    }
    // The signed hotel: linked by hand, audited.
    d = (await link(named.code).expect(200)).body as ContractDraftDetail;
    expect(d).toMatchObject({ hotel: { code: named.code }, canLinkHotel: false });
    const audit = await t.prisma.contractDraftEvent.findFirstOrThrow({
      where: { draft: { code: d.code }, kind: 'HOTEL_LINKED' },
    });
    expect(audit.details).toMatchObject({ from: null, to: named.code, signedRevisions: [1] });
    // Visible from the hotel, with its signed original.
    const atHotel = (await get(admin, `?hotel=${named.code}`).expect(200))
      .body as ContractDraftSummary[];
    expect(atHotel.map((x) => x.code)).toEqual([d.code]);
    expect(
      ((await get(admin, `/${d.code}`)).body as ContractDraftDetail).signed.map((x) => x.revision),
    ).toEqual([1]);
    await get(admin, `/${d.code}/signed/1`).expect(200);
    // Never changed afterwards — by the API or directly in the database.
    const again = await link(other.code, { acknowledgeMismatch: true });
    expect([again.status, again.body.code]).toEqual([409, 'CONTRACT_DRAFT_SIGNED']);
    const otherId = (await t.prisma.hotel.findFirstOrThrow({ where: { code: other.code } })).id;
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE contract_drafts SET hotel_id = '${otherId}', version = version + 1 WHERE code = '${d.code}'`,
      ),
    ).rejects.toThrow();
  });

  it('the linked hotel must be the one the revision being signed names; a draft acknowledgement never carries over (SIGN122-R3)', async () => {
    const files = async () =>
      (await readdir(t.storage.directory, { recursive: true, withFileTypes: true })).filter((e) =>
        e.isFile(),
      ).length;
    const p = await prospect(people.a.cookie, `Akvizice Pořadí ${tag}`);
    const right = await hotel(`Hotel Správný ${tag}`);
    const wrong = await hotel(`Hotel Chybný ${tag}`);
    const named = fields({
      hotelName: `Hotel Správný ${tag}`,
      hotelAddress: 'Hotelová 9, 602 00 Brno',
    });
    let d = (
      await post(people.a.cookie, '', { prospectCode: p.code, hotelCode: null, fields: named })
    ).body as ContractDraftDetail;
    // While a draft, the wrong hotel linked knowingly (acknowledged).
    d = (
      await post(admin, `/${d.code}/hotel`, {
        expectedVersion: d.version,
        hotelCode: wrong.code,
        reason: 'Omyl (test)',
        acknowledgeMismatch: true,
      }).expect(200)
    ).body as ContractDraftDetail;
    const pdf = await renderContractPdf(
      contractDocument('cs-b2b-1', {
        code: d.code,
        revision: 1,
        savedOn: '2026-11-02',
        fields: named,
      }),
    );
    const upload = (cookie: string, revision: number) =>
      http()
        .post(`${D}/${d.code}/signed`)
        .set('Cookie', cookie)
        .field('requestId', randomUUID())
        .field('expectedVersion', String(d.version))
        .field('revision', String(revision))
        .field('signedOn', '2026-11-02')
        .field('confirm', 'true')
        .attach('file', pdf, 'podepsano.pdf');
    const filesBefore = await files();
    const signedBefore = await t.prisma.contractSignedDocument.count();
    // The salesperson (no hotels:read): refused, nothing of the hotel record revealed.
    const bySales = await upload(people.a.cookie, 1);
    expect([bySales.status, bySales.body.code]).toEqual([409, 'HOTEL_NOT_SIGNED_REVISION']);
    expect(bySales.body.details).toBeUndefined();
    expect(JSON.stringify(bySales.body)).not.toContain('Chybný');
    expect(bySales.body.message).toContain('správce');
    // The administrator: refused, both identities named.
    const byAdmin = await upload(admin, 1);
    expect([byAdmin.status, byAdmin.body.code]).toEqual([409, 'HOTEL_NOT_SIGNED_REVISION']);
    expect(byAdmin.body.details).toMatchObject({
      revision: 1,
      draft: { name: `Hotel Správný ${tag}` },
      hotel: { code: wrong.code },
    });
    // No object stored, no record, the link not locked.
    expect(await files()).toBe(filesBefore);
    expect(await t.prisma.contractSignedDocument.count()).toBe(signedBefore);
    d = (await get(admin, `/${d.code}`).expect(200)).body as ContractDraftDetail;
    expect(d).toMatchObject({ signed: [], canLinkHotel: true, hotel: { code: wrong.code } });
    // Corrected, then the upload passes.
    d = (
      await post(admin, `/${d.code}/hotel`, {
        expectedVersion: d.version,
        hotelCode: right.code,
        reason: 'Oprava vazby (test)',
      }).expect(200)
    ).body as ContractDraftDetail;
    d = (await upload(people.a.cookie, 1).expect(201)).body as ContractDraftDetail;
    expect(d.signed.map((x) => x.revision)).toEqual([1]);
    expect(await files()).toBe(filesBefore + 1);

    // An amendment naming another hotel (acknowledged as a draft) is never signed under this hotel.
    d = (
      await post(admin, `/${d.code}/revisions`, {
        expectedVersion: d.version,
        reason: 'Dodatek s jiným hotelem (test)',
        fields: fields({ hotelName: 'Úplně jiný hotel', hotelAddress: 'Jinde 1, 100 00 Praha' }),
        acknowledgeHotelMismatch: true,
      }).expect(201)
    ).body as ContractDraftDetail;
    const amendment = await upload(admin, 2);
    expect([amendment.status, amendment.body.code]).toEqual([409, 'HOTEL_NOT_SIGNED_REVISION']);
    expect(await files()).toBe(filesBefore + 1);
    d = (await get(admin, `/${d.code}`)).body as ContractDraftDetail;
    expect(d.signed.map((x) => x.revision)).toEqual([1]);
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
    const doc = contractDocument('cs-b2b-1', {
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

  // A revision is printed with the version it was saved with (review CD121-2).
  const input: TemplateInput = {
    code: 'SN-000007',
    revision: 3,
    savedOn: '2026-11-03',
    fields: {
      counterpartyName: 'Ukázka s.r.o.',
      counterpartyCompanyId: '12345678',
      counterpartyAddress: 'Ukázková 1, 602 00 Brno',
      representativeName: 'Jana Ukázková',
      representativeRole: 'jednatelka',
      hotelName: 'Hotel Ukázka',
      hotelAddress: 'Hotelová 2, 602 00 Brno',
      rooms: 40,
      pricePerRoomMonth: '1200.50',
      currency: 'CZK',
      startOn: '2027-01-01',
      billingTiming: 'ARREARS',
      paymentTermsDays: 14,
      holders: 'WITH',
      holdersOwnership: 'CUSTOMER',
    },
  };
  it('cs-b2b-1 is frozen: the same revision always gives this document', () => {
    expect(contractDocument('cs-b2b-1', input)).toMatchInlineSnapshot(`
      {
        "meta": [
          "SN-000007 · revize 3 · šablona cs-b2b-1",
          "Revize uložena 3. 11. 2026",
        ],
        "notice": "Pracovní návrh připravený v AYVO OS. Není to schválený právní vzor ani uzavřená smlouva. Znění a chybějící ujednání doplní a schválí právní kontrola.",
        "sections": [
          {
            "heading": "1. Smluvní strany",
            "paragraphs": [
              "Dodavatel: [identifikace dodavatele – doplní právní kontrola]",
              "Odběratel: Ukázka s.r.o.",
              "IČO: 12345678",
              "Sídlo: Ukázková 1, 602 00 Brno",
              "Zastoupen: Jana Ukázková, jednatelka",
            ],
          },
          {
            "heading": "2. Předmět",
            "paragraphs": [
              "Služba AYVO pro hotel Hotel Ukázka, Hotelová 2, 602 00 Brno.",
              "[Přesný rozsah služby – doplní právní kontrola]",
            ],
          },
          {
            "heading": "3. Cena a fakturace",
            "paragraphs": [
              "Počet pokojů: 40",
              "Cena za pokoj a měsíc bez DPH: 1\u00a0200,50 CZK",
              "Začátek: 1. 1. 2027",
              "Fakturace: zpětně",
              "Splatnost: 14 dní",
              "Ceny jsou uvedeny bez DPH.",
            ],
          },
          {
            "heading": "4. Držáky",
            "paragraphs": [
              "[pracovní text k právní kontrole] Součástí služby jsou držáky. Držáky přejdou do vlastnictví zákazníka.",
              "[Okamžik a podmínky převodu vlastnictví, cena držáků a odpovědnost – doplní právní kontrola]",
            ],
          },
          {
            "heading": "5. Ostatní ujednání",
            "paragraphs": [
              "[Doba trvání, ukončení a další ujednání – doplní právní kontrola]",
            ],
          },
        ],
        "signatures": [
          "Za dodavatele: …………………………………………   Datum: ……………",
          "Za odběratele: …………………………………………   Datum: ……………",
        ],
        "title": "Smlouva o poskytování služby AYVO",
      }
    `);
  });
  it('a second version never changes an older revision; each is printed with its own; unknown is refused', () => {
    const second = {
      ...CONTRACT_TEMPLATES,
      'cs-b2b-2': () => ({
        title: 'Druhá verze',
        meta: [],
        notice: '',
        sections: [],
        signatures: [],
      }),
    };
    expect(contractDocument('cs-b2b-1', input, second)).toEqual(
      contractDocument('cs-b2b-1', input),
    );
    expect(contractDocument('cs-b2b-2', input, second).title).toBe('Druhá verze');
    expect(() => contractDocument('cs-b2b-9', input)).toThrow(UnknownContractTemplate);
    // Never a prototype member taken for a template.
    expect(() => contractDocument('toString', input)).toThrow(UnknownContractTemplate);
  });
});

describe('the signed original is a real, complete PDF (SIGN122-R1)', () => {
  const real = () =>
    renderContractPdf(
      contractDocument('cs-b2b-1', {
        code: 'SN-000009',
        revision: 1,
        savedOn: '2026-11-02',
        fields: {
          counterpartyName: 'Ukázka s.r.o.',
          counterpartyCompanyId: null,
          counterpartyAddress: null,
          representativeName: null,
          representativeRole: null,
          hotelName: 'Hotel',
          hotelAddress: 'Adresa',
          rooms: 1,
          pricePerRoomMonth: '10.00',
          currency: 'CZK',
          startOn: '2027-01-01',
          billingTiming: 'ARREARS',
          paymentTermsDays: 14,
          holders: 'NONE',
          holdersOwnership: null,
        },
      }),
    );
  it('a real PDF passes with its pages; the bytes are not touched', async () => {
    const pdf = await real();
    const copy = Buffer.from(pdf);
    expect((await inspectSignedPdf(pdf)).pages).toBeGreaterThanOrEqual(1);
    expect(Buffer.compare(pdf, copy)).toBe(0);
  });
  it('a header only, junk, a truncated file (also with %%EOF appended) and no page are refused', async () => {
    const pdf = await real();
    const half = pdf.subarray(0, Math.floor(pdf.length / 2));
    for (const bad of [
      Buffer.from('%PDF-1.4\n% jen hlavička\n%%EOF\n'),
      Buffer.from('%PDF-1.7\n' + 'x'.repeat(4000) + '\n%%EOF\n'),
      half,
      Buffer.concat([half, Buffer.from('\n%%EOF\n')]),
      pdf.subarray(0, pdf.length - 7),
      Buffer.from('not a pdf at all, really'),
    ])
      await expect(inspectSignedPdf(bad)).rejects.toThrow(InvalidSignedPdf);
  });
});
