import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crateFactory, createHotel, createOrder } from './support/order-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Supply plan access through REAL sign-in (doc 032 §5): managing plans is ADMIN only
 * (orders:plan_manage); reading needs orders:read at the hotel's serving site; a ship day change
 * needs orders:manage; a hotel served by another site is refused at the active site.
 */
describe.skipIf(!hasDatabase)('supply plan access and site isolation (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let other: SiteDetail;
  let product: string;
  let hotel: string;
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });
  const activeSite = (cookie: string, siteId: string) =>
    as(cookie).post('/api/auth/active-site', { siteId }).expect(200);
  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `plan-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Plánovač ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'supply plan access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    const cookie = await sessionCookie(ra, user.email);
    await activeSite(cookie, siteIds[0]!);
    return cookie;
  }
  async function role(permissions: string[]) {
    const code = `PLAN_${randomUUID().slice(0, 6).toUpperCase()}`;
    await as(admin)
      .post('/api/admin/identity/roles', {
        code,
        name: `Objednávky ${code}`,
        description: 'Objednávky bez plánů',
        permissions,
        reason: 'supply plan test role',
      })
      .expect(201);
    return code;
  }
  const plan = { validFrom: '2027-06-01', validTo: null };

  beforeAll(async () => {
    su = await createTestApp({ SUPPLY_PLAN_SECONDS: '0', CARRIER_POLL_SECONDS: '0' });
    ra = await createTestApp(
      { SUPPLY_PLAN_SECONDS: '0', CARRIER_POLL_SECONDS: '0' },
      {},
      { auth: 'real' },
    );
    product = (await crateFactory(su)).kit.productCode;
    hotel = (await createHotel(su)).code;
    const user = await prepareInvitedUser(ra, {
      email: `plan-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Plan Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await activeSite(admin, INITIAL_SITE_ID);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `PL-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Jiný sklad',
        countryCode: 'SK',
        addressLine1: 'Testovacia 3',
        addressLine2: null,
        postalCode: '811 02',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE'],
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

  it('only ADMIN may manage plans; orders:read only reads; existing roles gain nothing', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: { permissionCode: 'orders:plan_manage' },
      select: { roleCode: true },
    });
    expect(holders.map((h) => h.roleCode)).toEqual(['ADMIN']);
    const base = `/api/admin/orders/hotel/${hotel}/supply-plan`;
    const rules = [{ productCode: product, crates: 1, days: [3] }];
    const reader = await createUser([await role(['orders:read', 'orders:manage', 'hotels:read'])]);
    expect((await as(reader).get(base)).status).toBe(200);
    expect((await as(reader).get(`${base}/preview`)).status).toBe(403);
    for (const [path, body] of [
      ['', { requestId: randomUUID(), ...plan, rules, reason: 'zkouška' }],
      ['/preview', { ...plan, rules }],
      ['/activate', { requestId: randomUUID(), confirm: true, version: 1 }],
      ['/pause', { requestId: randomUUID(), reason: 'zkouška' }],
    ] as const) {
      expect((await as(reader).post(`${base}${path}`, body)).status, path).toBe(403);
    }
    for (const r of ['WAREHOUSE_SUPERVISOR', 'PRODUCTION_SUPERVISOR', 'WAREHOUSE_OPERATOR']) {
      const cookie = await createUser([r]);
      expect((await as(cookie).post(`${base}/preview`, { ...plan, rules })).status, r).toBe(403);
    }
    // ADMIN may, at the hotel's serving site.
    expect((await as(admin).post(`${base}/preview`, { ...plan, rules })).status).toBe(200);
    expect(
      (await as(admin).post(base, { requestId: randomUUID(), ...plan, rules, reason: 'plán' }))
        .status,
    ).toBe(200);
  });

  it('a hotel served by another site: refused at the active site, also for ADMIN', async () => {
    await activeSite(admin, other.id);
    const base = `/api/admin/orders/hotel/${hotel}/supply-plan`;
    const res = await as(admin).get(base);
    expect([res.status, res.body.code]).toEqual([409, 'HOTEL_OF_ANOTHER_SITE']);
    const preview = await as(admin).post(`${base}/preview`, {
      ...plan,
      rules: [{ productCode: product, crates: 1, days: [3] }],
    });
    expect([preview.status, preview.body.code]).toEqual([409, 'HOTEL_OF_ANOTHER_SITE']);
    const deliveries = await as(admin).get(`/api/admin/orders/hotel/${hotel}/deliveries`);
    expect((deliveries.body as { months: unknown[] }).months).toEqual([]); // nothing of this site
    await activeSite(admin, INITIAL_SITE_ID);
  });

  it('changing a ship day needs orders:manage', async () => {
    const order = await createOrder(su, hotel, [{ productCode: product, crates: 1 }]);
    const reader = await createUser([await role(['orders:read'])]);
    const res = await as(reader).post(`/api/admin/orders/${order.code}/reschedule`, {
      requestId: randomUUID(),
      shipDate: '2027-06-30',
      reason: 'zkouška',
    });
    expect(res.status).toBe(403);
    expect(
      (
        await as(admin).post(`/api/admin/orders/${order.code}/reschedule`, {
          requestId: randomUUID(),
          shipDate: '2027-06-30',
          reason: 'hotel chce později',
        })
      ).status,
    ).toBe(200);
  });
});
