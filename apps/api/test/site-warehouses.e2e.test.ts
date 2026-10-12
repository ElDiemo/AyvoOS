import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, CurrentUser, SiteDetail, StockOverview } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Creating a site's warehouse (doc 022 §2; v0.1: one warehouse per site, always its default)
 * through the real guard, sessions and database: authorization, reason and audit, idempotency,
 * the one-warehouse invariant under concurrency, globally unique codes, no invented inventory and
 * strict isolation from the initial site's MAIN warehouse.
 */
describe.skipIf(!hasDatabase)('site warehouses', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  const http = () => request(t.app.getHttpServer());
  const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });

  async function createSite(
    capabilities: string[] = ['WAREHOUSE', 'PRODUCTION', 'RETURNS'],
  ): Promise<SiteDetail> {
    const res = await as(admin).post('/api/admin/sites', {
      code: `DE-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Testwerk',
      countryCode: 'DE',
      addressLine1: 'Musterstraße 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      timeZone: 'Europe/Berlin',
      defaultLocale: 'de-DE',
      defaultCurrency: 'EUR',
      capabilities,
      reason: 'test site',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as SiteDetail;
  }

  const createWarehouse = (site: SiteDetail, body: Partial<Record<string, string>> = {}) =>
    as(admin).post(`/api/admin/sites/${site.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${site.code}-MAIN`,
      name: 'Hlavní sklad',
      reason: 'first warehouse of the site',
      ...body,
    });

  async function createUser(roles: string[], siteIds: string[]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: unique('user'),
      displayName: 'Test User',
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'test setup',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    return { user, cookie: await sessionCookie(t, user.email) };
  }

  /** Every inventory and receiving record, to prove that creating a warehouse invents none. */
  const inventoryCounts = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: await t.prisma.inventoryBalance.count(),
    lots: await t.prisma.inventoryLot.count(),
    receipts: await t.prisma.goodsReceipt.count(),
    receiptLines: await t.prisma.goodsReceiptLine.count(),
    documents: await t.prisma.supplierDocument.count(),
  });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('warehouse-admin'),
      displayName: 'Warehouse Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('creates the first warehouse as the site default, audited, without inventing inventory', async () => {
    const site = await createSite();
    expect(site.warehouses).toEqual([]);
    const before = await inventoryCounts();
    const mainBefore = await t.prisma.inventoryLocation.findUniqueOrThrow({
      where: { code: 'MAIN' },
    });

    const requestId = randomUUID();
    const res = await createWarehouse(site, { requestId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = res.body as SiteDetail;
    expect(after.warehouses).toEqual([
      { code: `${site.code}-MAIN`, name: 'Hlavní sklad', default: true },
    ]);
    // The site itself is unchanged: capabilities, status, no other edits.
    expect(after.capabilities).toEqual(site.capabilities);
    expect(after.active).toBe(true);
    expect(after.updatedAt).toBe(site.updatedAt);
    expect(after.audit[0]).toMatchObject({
      type: 'WAREHOUSE_CREATED',
      reason: 'first warehouse of the site',
      details: {
        site: site.code,
        warehouse: `${site.code}-MAIN`,
        name: 'Hlavní sklad',
        default: true,
        requestId,
      },
    });
    expect(await inventoryCounts()).toEqual(before);
    // The initial site's MAIN warehouse is untouched.
    expect(await t.prisma.inventoryLocation.findUniqueOrThrow({ where: { code: 'MAIN' } })).toEqual(
      mainBefore,
    );
    expect(mainBefore).toMatchObject({ siteId: INITIAL_SITE_ID, isSiteDefault: true });
  });

  it('the database keeps one default per site and the warehouse immutable', async () => {
    const site = await createSite();
    expect((await createWarehouse(site)).status).toBe(201);
    const created = await t.prisma.inventoryLocation.findFirstOrThrow({
      where: { siteId: site.id },
    });
    // A second default for the site, even bypassing the API, is refused by the database.
    await expect(
      t.prisma.inventoryLocation.create({
        data: { siteId: site.id, code: `${site.code}-X`, name: 'X', isSiteDefault: true },
      }),
    ).rejects.toThrow();
    // A warehouse code that exists anywhere is refused by the database.
    await expect(
      t.prisma.inventoryLocation.create({
        data: { siteId: site.id, code: 'MAIN', name: 'X', isSiteDefault: false },
      }),
    ).rejects.toThrow();
    // Code, site and default flag never change; warehouses are never deleted.
    await expect(
      t.prisma.inventoryLocation.update({ where: { id: created.id }, data: { code: 'RENAMED' } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.inventoryLocation.update({
        where: { id: created.id },
        data: { siteId: INITIAL_SITE_ID },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.inventoryLocation.delete({ where: { id: created.id } }),
    ).rejects.toThrow();
    expect(await t.prisma.inventoryLocation.findMany({ where: { siteId: site.id } })).toEqual([
      created,
    ]);
  });

  it('requires a reason and valid fields; nothing is created otherwise', async () => {
    const site = await createSite();
    for (const body of [
      { reason: '' },
      { reason: '  ' },
      { code: 'main' },
      { code: 'X' },
      { code: 'A'.repeat(21) },
      { name: ' ' },
      { requestId: 'not-a-uuid' },
    ]) {
      const res = await createWarehouse(site, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await t.prisma.inventoryLocation.count({ where: { siteId: site.id } })).toBe(0);
    expect(
      await t.prisma.auditEvent.count({ where: { type: 'WAREHOUSE_CREATED', siteId: site.id } }),
    ).toBe(0);
  });

  it('is idempotent per request id; a reused id with other data is a conflict', async () => {
    const site = await createSite();
    const requestId = randomUUID();
    const first = await createWarehouse(site, { requestId });
    expect(first.status).toBe(201);
    const replay = await createWarehouse(site, { requestId });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.warehouses).toEqual(first.body.warehouses);
    expect(await t.prisma.inventoryLocation.count({ where: { siteId: site.id } })).toBe(1);
    expect(
      await t.prisma.auditEvent.count({ where: { type: 'WAREHOUSE_CREATED', siteId: site.id } }),
    ).toBe(1);

    const changed = await createWarehouse(site, { requestId, name: 'Jiný sklad' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const elsewhere = await createWarehouse(await createSite(), { requestId });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('allows exactly one warehouse per site; a second one is refused', async () => {
    const site = await createSite();
    expect((await createWarehouse(site)).status).toBe(201);
    const second = await createWarehouse(site, { code: `${site.code}-B`, name: 'Druhý sklad' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SITE_HAS_WAREHOUSE');
    expect(await t.prisma.inventoryLocation.count({ where: { siteId: site.id } })).toBe(1);
  });

  it('concurrent requests never create two warehouses for one site', async () => {
    const site = await createSite();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createWarehouse(site, { code: `${site.code}-C${i}`, name: `Sklad ${i}` }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((r) => r.status === 409)) {
      expect(r.body.code).toBe('SITE_HAS_WAREHOUSE');
    }
    const locations = await t.prisma.inventoryLocation.findMany({ where: { siteId: site.id } });
    expect(locations).toHaveLength(1);
    expect(locations[0]!.isSiteDefault).toBe(true);
    expect(
      await t.prisma.auditEvent.count({ where: { type: 'WAREHOUSE_CREATED', siteId: site.id } }),
    ).toBe(1);
  });

  it('warehouse codes are unique across all sites: MAIN and another site’s code are refused', async () => {
    const taken = await createSite();
    expect((await createWarehouse(taken)).status).toBe(201);
    const site = await createSite();
    for (const code of ['MAIN', `${taken.code}-MAIN`]) {
      const res = await createWarehouse(site, { code });
      expect(res.status, code).toBe(409);
      expect(res.body.code).toBe('WAREHOUSE_CODE_EXISTS');
    }
    expect(await t.prisma.inventoryLocation.count({ where: { siteId: site.id } })).toBe(0);
    // The site can still get its own code afterwards.
    expect((await createWarehouse(site)).status).toBe(201);
  });

  it('refuses a site without the WAREHOUSE capability and an inactive site', async () => {
    const production = await createSite(['PRODUCTION']);
    const res = await createWarehouse(production);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SITE_NOT_WAREHOUSE');

    const inactive = await createSite();
    await as(admin)
      .post(`/api/admin/sites/${inactive.id}/deactivate`, { reason: 'closed before opening' })
      .expect(200);
    const refused = await createWarehouse(inactive);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SITE_INACTIVE');
    expect(
      await t.prisma.inventoryLocation.count({
        where: { siteId: { in: [production.id, inactive.id] } },
      }),
    ).toBe(0);
  });

  it('only sites:manage may create a warehouse — enforced by the server', async () => {
    const site = await createSite();
    const supervisor = await createUser(['WAREHOUSE_SUPERVISOR'], [site.id, INITIAL_SITE_ID]);
    const body = {
      requestId: randomUUID(),
      code: `${site.code}-MAIN`,
      name: 'Hlavní sklad',
      reason: 'direct call without permission',
    };
    const forbidden = await as(supervisor.cookie).post(
      `/api/admin/sites/${site.id}/warehouses`,
      body,
    );
    expect(forbidden.status).toBe(403);
    const anonymous = await http().post(`/api/admin/sites/${site.id}/warehouses`).send(body);
    expect(anonymous.status).toBe(401);
    const unknown = await as(admin).post(`/api/admin/sites/${randomUUID()}/warehouses`, body);
    expect(unknown.status).toBe(404);
    expect(await t.prisma.inventoryLocation.count({ where: { siteId: site.id } })).toBe(0);
  });

  it('the new warehouse starts empty and stays isolated from the initial site', async () => {
    const site = await createSite();
    const deUser = await createUser(['WAREHOUSE_SUPERVISOR'], [site.id]);
    // Before the warehouse exists, warehouse operations at the site are blocked.
    const blocked = await as(deUser.cookie).get('/api/admin/inventory/stock');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SITE_WITHOUT_WAREHOUSE');

    const czOnly = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
    const czBefore = (await as(czOnly.cookie).get('/api/admin/inventory/stock').expect(200))
      .body as StockOverview;

    expect((await createWarehouse(site)).status).toBe(201);

    // The German warehouse: zero stock, no receipts, no movements.
    const deStock = (await as(deUser.cookie).get('/api/admin/inventory/stock').expect(200))
      .body as StockOverview;
    expect(deStock.location.code).toBe(`${site.code}-MAIN`);
    for (const item of deStock.items) expect(Number(item.onHand), item.item.code).toBe(0);
    const receipts = await as(deUser.cookie)
      .get('/api/admin/goods-receipts?pageSize=100')
      .expect(200);
    expect(receipts.body.items).toEqual([]);
    const movements = await as(deUser.cookie)
      .get('/api/admin/inventory/movements?pageSize=100')
      .expect(200);
    expect(movements.body.items).toEqual([]);

    // The initial site is unchanged, and its user never reaches the new site.
    const czAfter = (await as(czOnly.cookie).get('/api/admin/inventory/stock').expect(200))
      .body as StockOverview;
    expect(czAfter).toEqual(czBefore);
    expect(czAfter.location.code).toBe('MAIN');
    const forged = await as(czOnly.cookie).post('/api/auth/active-site', { siteId: site.id });
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('SITE_FORBIDDEN');
    const me = (await as(czOnly.cookie).get('/api/auth/me')).body as CurrentUser;
    expect(me.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);

    // A user of both sites switches between them without mixing data.
    const multi = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID, site.id]);
    await as(multi.cookie).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    const atDe = (await as(multi.cookie).get('/api/admin/inventory/stock')).body as StockOverview;
    await as(multi.cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    const atCz = (await as(multi.cookie).get('/api/admin/inventory/stock')).body as StockOverview;
    expect(atDe).toEqual(deStock);
    expect(atCz).toEqual(czBefore);
  });
});
