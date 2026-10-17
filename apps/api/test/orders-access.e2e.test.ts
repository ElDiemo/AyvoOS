import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, OrderDetail, OrderList, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crateFactory, hotelBody, pragueToday } from './support/order-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * Orders and picking through REAL sign-in (doc 028 §4): the new permissions exist only for ADMIN
 * (no existing role gains them); orders, their hotel lists and crates of another site are not
 * visible or usable; any user who may pick at the site continues another user's open picking.
 * The superuser app makes the synthetic finished crates; the real-auth app runs every request.
 */
describe.skipIf(!hasDatabase)('orders access and site isolation (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let soap: Factory;
  let other: SiteDetail;
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });
  const activeSite = (cookie: string, siteId: string) =>
    as(cookie).post('/api/auth/active-site', { siteId }).expect(200);

  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `order-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Expedient ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'orders access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cookie = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await activeSite(cookie, siteIds[0]!);
    return cookie;
  }
  async function order(cookie: string, hotelCode: string, crates = 1) {
    const res = await as(cookie).post('/api/admin/orders', {
      requestId: randomUUID(),
      hotelCode,
      requestedShipDate: pragueToday(1),
      lines: [{ productCode: soap.kit.productCode, crates }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as OrderDetail;
  }
  async function hotel(cookie: string, fulfillmentSiteId: string) {
    const res = await as(cookie).post('/api/admin/hotels', hotelBody({ fulfillmentSiteId }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { code: string };
  }

  beforeAll(async () => {
    su = await createTestApp();
    ra = await createTestApp({}, {}, { auth: 'real' });
    soap = await crateFactory(su);
    const user = await prepareInvitedUser(ra, {
      email: `order-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Order Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await activeSite(admin, INITIAL_SITE_ID);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `SK-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Druhý sklad',
        countryCode: 'SK',
        addressLine1: 'Testovacia 1',
        addressLine2: null,
        postalCode: '811 01',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE', 'PRODUCTION'],
        reason: 'second site',
      })
    ).body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${other.id}/warehouses`, {
        requestId: randomUUID(),
        code: `${other.code}-W`,
        name: 'Sklad',
        reason: 'first warehouse',
      })
      .expect(201);
  });
  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
    await su?.close();
  });

  it('only ADMIN holds the new permissions; existing roles gain nothing', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: {
        permissionCode: {
          in: ['hotels:read', 'hotels:manage', 'orders:read', 'orders:manage', 'orders:pick'],
        },
      },
      select: { roleCode: true },
    });
    expect([...new Set(holders.map((h) => h.roleCode))]).toEqual(['ADMIN']);
    for (const role of ['WAREHOUSE_SUPERVISOR', 'PRODUCTION_SUPERVISOR']) {
      const user = await createUser([role]);
      for (const path of ['/api/admin/hotels', '/api/admin/orders', '/api/admin/orders/products']) {
        expect((await as(user).get(path)).status, `${role} ${path}`).toBe(403);
      }
      expect((await as(user).post('/api/admin/hotels', hotelBody())).status).toBe(403);
    }
  });

  it('orders of another site are invisible; its hotel and crates cannot be used here', async () => {
    const here = await hotel(admin, INITIAL_SITE_ID);
    const there = await hotel(admin, other.id);
    // An order belongs to the hotel's fulfilment site, never to the active site of someone else.
    const wrong = await as(admin).post('/api/admin/orders', {
      requestId: randomUUID(),
      hotelCode: there.code,
      requestedShipDate: pragueToday(1),
      lines: [{ productCode: soap.kit.productCode, crates: 1 }],
    });
    expect([wrong.status, wrong.body.code]).toEqual([409, 'HOTEL_OF_ANOTHER_SITE']);
    await activeSite(admin, other.id);
    const remote = await order(admin, there.code);
    expect(remote.site.code).toBe(other.code);
    const reg = await as(admin)
      .post('/api/admin/crate-registrations', {
        requestId: randomUUID(),
        crateTypeCode: soap.kit.crateTypeCode,
        quantity: 1,
      })
      .expect(201);
    const remoteCrate = await ra.prisma.crate.findUniqueOrThrow({
      where: { code: reg.body.crateCodes[0] },
    });
    await activeSite(admin, INITIAL_SITE_ID);
    const local = await order(admin, here.code);

    // A picker of the initial site only.
    const role = `ORDER_PICKER_${randomUUID().slice(0, 6).toUpperCase()}`;
    await as(admin)
      .post('/api/admin/identity/roles', {
        code: role,
        name: 'Expedice',
        description: 'Kompletace objednávek',
        permissions: ['orders:read', 'orders:pick', 'hotels:read'],
        reason: 'orders test role',
      })
      .expect(201);
    const picker = await createUser([role]);
    expect((await as(picker).get(`/api/admin/orders/${remote.code}`)).status).toBe(404);
    const codes: string[] = [];
    for (let page = 1; ; page++) {
      const list = (
        await as(picker).get(`/api/admin/orders?view=future&pageSize=100&page=${page}`).expect(200)
      ).body as OrderList;
      codes.push(...list.items.map((o) => o.code));
      if (page * list.pageSize >= list.total) break;
    }
    expect(codes).toContain(local.code);
    expect(codes).not.toContain(remote.code);
    expect(
      (await as(picker).get(`/api/admin/orders/hotel/${there.code}`).expect(200)).body,
    ).toMatchObject({ items: [], total: 0 });
    // Picking another site's order: not found, whatever is scanned.
    const ownCrate = await soap.make();
    const scanRemote = await as(picker).post(`/api/admin/orders/${remote.code}/crates`, {
      requestId: randomUUID(),
      scannedValue: ownCrate.crateUrl,
    });
    expect(scanRemote.status).toBe(404);
    const completeRemote = await as(picker).post(`/api/admin/orders/${remote.code}/complete`, {
      requestId: randomUUID(),
    });
    expect(completeRemote.status).toBe(404);
    // A crate of the other site is refused in a local order.
    const foreign = await as(picker).post(`/api/admin/orders/${local.code}/crates`, {
      requestId: randomUUID(),
      scannedValue: `${TEST_QR_BASE_URL}/${remoteCrate.qrToken}`,
    });
    expect([foreign.status, foreign.body.code]).toEqual([409, 'CRATE_OF_ANOTHER_SITE']);
    // Picking is not order management.
    expect(
      (
        await as(picker).post(`/api/admin/orders/${local.code}/cancel`, {
          requestId: randomUUID(),
          reason: 'ne',
        })
      ).status,
    ).toBe(403);
    expect((await as(picker).post('/api/admin/hotels', hotelBody())).status).toBe(403);
    await activeSite(admin, other.id);
    await as(admin)
      .post(`/api/admin/orders/${remote.code}/cancel`, {
        requestId: randomUUID(),
        reason: 'konec testu',
      })
      .expect(200);
    await activeSite(admin, INITIAL_SITE_ID);
    await as(admin)
      .post(`/api/admin/orders/${local.code}/cancel`, {
        requestId: randomUUID(),
        reason: 'konec testu',
      })
      .expect(200);
  });

  it('another authorized worker continues an open picking', async () => {
    const role = `ORDER_PICKER_${randomUUID().slice(0, 6).toUpperCase()}`;
    await as(admin)
      .post('/api/admin/identity/roles', {
        code: role,
        name: 'Expedice B',
        description: 'Kompletace objednávek',
        permissions: ['orders:read', 'orders:pick'],
        reason: 'orders test role',
      })
      .expect(201);
    const [first, second] = [await createUser([role]), await createUser([role])];
    const h = await hotel(admin, INITIAL_SITE_ID);
    const o = await order(admin, h.code, 2);
    const [a, b] = [await soap.make(), await soap.make()];
    await as(first)
      .post(`/api/admin/orders/${o.code}/crates`, {
        requestId: randomUUID(),
        scannedValue: a.crateUrl,
      })
      .expect(200);
    // The first worker leaves; the second one opens the same order and finishes it.
    await as(second)
      .post(`/api/admin/orders/${o.code}/crates`, {
        requestId: randomUUID(),
        scannedValue: b.crateUrl,
      })
      .expect(200);
    const done = await as(second)
      .post(`/api/admin/orders/${o.code}/complete`, { requestId: randomUUID() })
      .expect(200);
    const detail = done.body as OrderDetail;
    expect(detail.status).toBe('READY_TO_DISPATCH');
    const actors = detail.history.filter((e) => e.type === 'CRATE_ADDED').map((e) => e.actor);
    expect(new Set(actors).size).toBe(2);
    expect(detail.completedBy).toBe(actors[1]);
    await as(admin)
      .post(`/api/admin/orders/${o.code}/cancel`, {
        requestId: randomUUID(),
        reason: 'konec testu',
      })
      .expect(200);
  });

  async function siteWithWarehouse(prefix: string) {
    const site = (
      await as(admin)
        .post('/api/admin/sites', {
          code: `${prefix}-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Provozovna k uzavření',
          countryCode: 'SK',
          addressLine1: 'Testovacia 2',
          addressLine2: null,
          postalCode: '811 02',
          city: 'Bratislava',
          timeZone: 'Europe/Bratislava',
          defaultLocale: 'sk-SK',
          defaultCurrency: 'EUR',
          capabilities: ['WAREHOUSE'],
          reason: 'deactivation test',
        })
        .expect(201)
    ).body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${site.id}/warehouses`, {
        requestId: randomUUID(),
        code: `${site.code}-W`,
        name: 'Sklad',
        reason: 'first warehouse',
      })
      .expect(201);
    return site;
  }
  const blockers = async (siteId: string) =>
    (
      (await as(admin).get(`/api/admin/sites/${siteId}`).expect(200)).body as SiteDetail
    ).deactivationBlockers.map((b) => b.code);

  it('a site serving hotels or holding unclosed orders cannot be deactivated (no stock needed)', async () => {
    const site = await siteWithWarehouse('DH');
    expect(await blockers(site.id)).toEqual([]); // zero stock, another site active
    const h = await hotel(admin, site.id);
    expect(await blockers(site.id)).toEqual(['HOTELS_SERVED']);
    const refused = await as(admin).post(`/api/admin/sites/${site.id}/deactivate`, {
      reason: 'closing',
    });
    expect([refused.status, refused.body.code]).toEqual([409, 'SITE_DEPENDENCIES']);
    await activeSite(admin, site.id);
    const o = await order(admin, h.code);
    expect(await blockers(site.id)).toEqual(['HOTELS_SERVED', 'ORDERS_NOT_CLOSED']);
    await as(admin)
      .post(`/api/admin/orders/${o.code}/cancel`, { requestId: randomUUID(), reason: 'konec' })
      .expect(200);
    await activeSite(admin, INITIAL_SITE_ID);
    expect(await blockers(site.id)).toEqual(['HOTELS_SERVED']); // the cancelled order is closed
    const site2 = (await ra.prisma.site.findUniqueOrThrow({ where: { id: site.id } })).active;
    expect(site2).toBe(true); // nothing changed by the refusals
    // The database refuses it on its own as well.
    await expect(
      ra.prisma.site.update({ where: { id: site.id }, data: { active: false } }),
    ).rejects.toThrow(/stays active/);
    expect(await ra.prisma.order.count({ where: { code: o.code } })).toBe(1); // history kept
  });

  it('a hotel created while its site is being deactivated never ends up on an inactive site', async () => {
    for (let i = 0; i < 4; i++) {
      const site = await siteWithWarehouse('RC');
      const [deactivated, created] = await Promise.all([
        as(admin).post(`/api/admin/sites/${site.id}/deactivate`, { reason: 'souběh' }),
        as(admin).post('/api/admin/hotels', hotelBody({ fulfillmentSiteId: site.id })),
      ]);
      const active = (await ra.prisma.site.findUniqueOrThrow({ where: { id: site.id } })).active;
      const hotels = await ra.prisma.hotel.count({ where: { fulfillmentSiteId: site.id } });
      // Exactly one side wins: deactivated without a hotel, or the hotel and an active site.
      if (deactivated.status === 200) {
        expect([created.status, created.body.code]).toEqual([422, 'FULFILLMENT_SITE_INVALID']);
        expect([active, hotels]).toEqual([false, 0]);
      } else {
        expect([deactivated.status, deactivated.body.code]).toEqual([409, 'SITE_DEPENDENCIES']);
        expect(created.status).toBe(201);
        expect([active, hotels]).toEqual([true, 1]);
      }
    }
  });
});
