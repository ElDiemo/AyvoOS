import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  financeCommissionAttributionsSchema,
  type AdminUserDetail,
  type FinanceCommissionAttributions,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Sales commissions PR 2a — the core contract the Finance closing reads (doc 069 §4; owner
 * approved doc 069 §3–§6 and O1–O16 on 2026-11-18). Real sign-in and the Finance service token
 * with a forwarded session, as Finance calls it. Per hotel and service month: the attribution in
 * force (same rule as the portfolio), its recipient and the rates bound to it — never the
 * salesperson's current terms. At most 200 hotels per request, read-only, only for
 * `finance:commissions_manage` (ADMIN). Synthetic data only; no amount anywhere.
 */
describe.skipIf(!hasDatabase)('core contract: commission attributions for Finance', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const token = randomBytes(32).toString('base64url');
  const people: Record<'a' | 'b' | 'c', { id: string; cookie: string; name: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const tag = randomUUID().slice(0, 6);
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const session = (cookie: string) => cookie.replace(/^ayvo_session=/, '').split(';')[0]!;
  const PATH = '/api/internal/v1/finance/commissions/attributions';
  const contract = (body: object, cookie = admin, bearer = token) =>
    http()
      .post(PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set('x-ayvo-session', session(cookie))
      .send(body);
  const read = async (month: string, hotelIds: string[]) => {
    const res = await contract({ month, hotelIds });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return financeCommissionAttributionsSchema.parse(res.body) as FinanceCommissionAttributions;
  };
  const counts = async () => ({
    attributions: await t.prisma.salesHotelAttribution.count(),
    bindings: await t.prisma.salesHotelCommissionTerms.count(),
    terms: await t.prisma.salesCommissionTerms.count(),
  });

  async function createUser(roles: string[], displayName: string) {
    const email = unique('fcc');
    const created = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({ email, displayName, roles, siteIds: [], warehouseCodes: [], reason: 'commissions' })
      .expect(201);
    return {
      id: (created.body as AdminUserDetail).id,
      cookie: await sessionCookie(t, email),
      name: displayName,
    };
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
        contactPhone: '+420 500 000 069',
        contactEmail: 'recepce@provize.test',
        fulfillmentSiteId: INITIAL_SITE_ID,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [row] = await t.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "hotels" WHERE "code" = ${(res.body as { code: string }).code}`;
    return { code: (res.body as { code: string }).code, id: row!.id };
  }

  const attribute = async (code: string, body: object) => {
    const res = await http()
      .post(`/api/admin/hotels/${code}/sales-attribution`)
      .set('Cookie', admin)
      .send({
        requestId: randomUUID(),
        expectedRevision: 0,
        source: 'MANUAL',
        reason: 'stávající hotel bez akvizice',
        confirm: true,
        ...body,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };

  beforeAll(async () => {
    t = await createTestApp(
      { FINANCE_SERVICE_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') },
      {},
      { auth: 'real' },
    );
    const user = await prepareInvitedUser(t, {
      email: unique('fcc-admin'),
      displayName: 'Admin Uzávěrky',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    people.a = await createUser(['SALES'], `Alena Fiktivní ${tag}`);
    people.b = await createUser(['SALES'], `Bohdan Smyšlený ${tag}`);
    people.c = await createUser(['SALES'], `Cyril Bezpodmínek ${tag}`);
    await terms(people.a.id, 0, { initialRate: '20', initialMonths: 24, maintenanceRate: '5' });
    await terms(people.b.id, 0, { initialRate: '10', initialMonths: 36, maintenanceRate: '3' });
  });
  afterAll(async () => {
    // Test files share one database: the identity tests bootstrap the first ADMIN themselves.
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('the month in force, the recipient and the bound rates; a company hotel, missing terms, no attribution, before the start', async () => {
    const h = {
      a: await hotel('Hotel Alena'),
      house: await hotel('Hotel Firemní'),
      noTerms: await hotel('Hotel Bez podmínek'),
      none: await hotel('Hotel Nepřiřazený'),
    };
    await attribute(h.a.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-06',
      confirmCommissionStart: true,
    });
    await attribute(h.house.code, {
      salespersonId: null,
      commissionStart: '2027-06',
      confirmCommissionStart: true,
    });
    await attribute(h.noTerms.code, {
      salespersonId: people.c.id,
      commissionStart: '2027-06',
      confirmCommissionStart: true,
    });
    const unknown = randomUUID();
    const ids = [h.a.id, h.house.id, h.noTerms.id, h.none.id, unknown];
    const before = await counts();
    const july = await read('2027-07', ids);

    expect(july.month).toBe('2027-07');
    expect(july.hotels.map((x) => x.hotelId)).toEqual([...ids].sort()); // canonical order
    const by = new Map(july.hotels.map((x) => [x.hotelId, x]));
    expect(by.get(h.a.id)).toEqual({
      hotelId: h.a.id,
      commissionStart: '2027-06',
      attribution: {
        revision: 1,
        effectiveFrom: '2027-06',
        commissionStart: '2027-06',
        recipient: { salespersonId: people.a.id, displayName: people.a.name },
        binding: {
          bindingId: expect.any(String),
          termsVersion: 1,
          initialRate: '20.00',
          initialMonths: 24,
          maintenanceRate: '5.00',
        },
      },
    });
    expect(by.get(h.house.id)!.attribution).toMatchObject({ recipient: null, binding: null });
    expect(by.get(h.noTerms.id)!.attribution).toMatchObject({
      recipient: { salespersonId: people.c.id },
      binding: null,
    });
    expect(by.get(h.none.id)).toEqual({
      hotelId: h.none.id,
      commissionStart: null,
      attribution: null,
    });
    expect(by.get(unknown)).toEqual({ hotelId: unknown, commissionStart: null, attribution: null });

    // Before the first paid month: no attribution in force, but the start tells Finance why.
    const may = await read('2027-05', [h.a.id]);
    expect(may.hotels[0]).toEqual({
      hotelId: h.a.id,
      commissionStart: '2027-06',
      attribution: null,
    });

    // Read-only, deterministic and independent of the request's order.
    const again = await read('2027-07', [...ids].reverse());
    expect(again).toEqual(july);
    expect(await counts()).toEqual(before);
  });

  it('a later change, a same-month correction and a planned change; the hotel keeps the rates bound at the time', async () => {
    const h = await hotel('Hotel Předání');
    await attribute(h.code, {
      salespersonId: people.a.id,
      commissionStart: '2027-01',
      confirmCommissionStart: true,
    });
    // A's newer terms after the binding never reach this hotel.
    await terms(people.a.id, 1, { initialRate: '25', initialMonths: 12, maintenanceRate: '6' });
    // B from April (planned), then a correction of April to C (same month, higher revision).
    await attribute(h.code, {
      expectedRevision: 1,
      salespersonId: people.b.id,
      effectiveFrom: '2027-04',
      reason: 'předání portfolia',
    });
    await attribute(h.code, {
      expectedRevision: 2,
      salespersonId: people.c.id,
      effectiveFrom: '2027-04',
      reason: 'oprava: hotel převzal Cyril',
    });

    const march = (await read('2027-03', [h.id])).hotels[0]!;
    expect(march.attribution).toMatchObject({
      revision: 1,
      recipient: { salespersonId: people.a.id },
      binding: {
        termsVersion: 1,
        initialRate: '20.00',
        initialMonths: 24,
        maintenanceRate: '5.00',
      },
    });
    const aprilBefore = await read('2027-04', [h.id]);
    const april = aprilBefore.hotels[0]!;
    expect(april.attribution).toMatchObject({
      revision: 3,
      effectiveFrom: '2027-04',
      commissionStart: '2027-01',
      recipient: { salespersonId: people.c.id },
      binding: null, // Cyril has no terms
    });
    expect(april.commissionStart).toBe('2027-01');

    // A correction of a month already read changes that month's fingerprint (doc 069 §5b).
    const before = await read('2027-05', [h.id]);
    await terms(people.c.id, 0, { initialRate: '15', initialMonths: 24, maintenanceRate: '4' });
    await attribute(h.code, {
      expectedRevision: 3,
      salespersonId: people.b.id,
      effectiveFrom: '2027-05',
      reason: 'od května Bohdan',
    });
    const after = await read('2027-05', [h.id]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.hotels[0]!.attribution).toMatchObject({
      revision: 4,
      recipient: { salespersonId: people.b.id },
      binding: { initialRate: '10.00', initialMonths: 36, maintenanceRate: '3.00' },
    });
    // April is unchanged by the May revision, and so is its fingerprint.
    const aprilAgain = await read('2027-04', [h.id]);
    expect(aprilAgain.hotels[0]!.attribution!.revision).toBe(3);
    expect(aprilAgain.fingerprint).toBe(aprilBefore.fingerprint);
  });

  it('batches of at most 200 unique hotels and a valid month', async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID());
    const tooMany = await contract({ month: '2027-07', hotelIds: ids });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.body)).toContain('hotelIds');
    const ok = await read('2027-07', ids.slice(0, 200));
    expect(ok.hotels).toHaveLength(200);
    for (const body of [
      { month: '2027-07', hotelIds: [] },
      { month: '2027-07', hotelIds: [ids[0], ids[0]] },
      { month: '2027-13', hotelIds: [ids[0]] },
      { month: '2027-07-01', hotelIds: [ids[0]] },
      { month: '2027-07', hotelIds: ['not-a-uuid'] },
      { month: '2027-07', hotelIds: [ids[0]], extra: true },
    ])
      expect((await contract(body)).status, JSON.stringify(body)).toBe(400);
  });

  it('only the Finance service with a session allowed to approve statements; never from the browser', async () => {
    const body = { month: '2027-07', hotelIds: [randomUUID()] };
    // No or a wrong service token.
    const none = await http().post(PATH).set('x-ayvo-session', session(admin)).send(body);
    expect([none.status, none.body.code]).toEqual([401, 'SERVICE_UNAUTHENTICATED']);
    const wrong = await contract(body, admin, 'not-the-token');
    expect([wrong.status, wrong.body.code]).toEqual([401, 'SERVICE_UNAUTHENTICATED']);
    // The service without a user session.
    const noUser = await http().post(PATH).set('Authorization', `Bearer ${token}`).send(body);
    expect(noUser.status).toBe(401);
    // A salesperson (sales:work) never reads it — not even for their own hotels.
    expect((await contract(body, people.a.cookie)).status).toBe(403);
    // A browser session cookie without the service token is refused.
    const browser = await http().post(PATH).set('Cookie', admin).send(body);
    expect(browser.status).toBe(401);
  });

  it('the permission is ADMIN-only and can never be put into a custom role', async () => {
    const grants = await t.prisma.rolePermission.findMany({
      where: { permissionCode: 'finance:commissions_manage' },
      select: { roleCode: true },
    });
    expect(grants).toEqual([{ roleCode: 'ADMIN' }]);
    const perm = await t.prisma.permission.findUnique({
      where: { code: 'finance:commissions_manage' },
    });
    expect(perm).toMatchObject({ securityAdmin: true, siteScoped: false, warehouseScoped: false });
    const code = `PROVIZE_${randomUUID().slice(0, 4).toUpperCase()}`;
    const role = await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code,
        name: 'Schvalování provizí',
        description: '',
        permissions: ['sales:manage', 'finance:commissions_manage'],
        reason: 'attempt',
      });
    expect([role.status, role.body.code]).toEqual([422, 'SECURITY_PERMISSION_RESERVED']);
    await expect(
      withPrivileged(async (db) => {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "roles" ("code", "name", "description", "is_system", "active")
                               VALUES (${code}, 'X', '', false, true)`;
          await tx.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code")
                               VALUES (${code}, 'finance:commissions_manage')`;
        });
      }),
    ).rejects.toThrow(/custom role cannot hold a security-administration permission/);
  });
});
