import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  CurrentUser,
  GoodsReceipt,
  RoleDetail,
  SiteDetail,
  StockOverview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { newBottleItemId, PDF_BYTES } from './support/warehouse-fixtures.js';

/**
 * Custom roles (doc 021 §7a) and the multi-site foundation (doc 022): role administration with
 * immediate effect, protected system roles, no privilege escalation, site administration, and
 * strict isolation between sites — all through the real guard, sessions and database.
 *
 * The administrator is created directly (the one-time bootstrap belongs to identity.e2e) and
 * loses ADMIN again at the end, so the last-administrator test there is unaffected.
 */
describe.skipIf(!hasDatabase)('custom roles and sites', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  let de: SiteDetail;
  const http = () => request(t.app.getHttpServer());
  const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });

  async function createUser(roles: string[], siteIds: string[], warehouseCodes: string[] = []) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: unique('user'),
      displayName: 'Test User',
      roles,
      siteIds,
      warehouseCodes,
      reason: 'test setup',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    return { user, cookie: await sessionCookie(t, user.email) };
  }

  /** A warehouse is created by migration in v0.1; tests add one directly for a new site. */
  async function addWarehouse(siteId: string, code: string, isDefault = true) {
    await t.prisma.inventoryLocation.create({
      data: { code, name: `Sklad ${code}`, siteId, isSiteDefault: isDefault },
    });
  }

  async function receive(cookie: string, quantity: string): Promise<GoodsReceipt> {
    const supplier = await as(cookie).post('/api/admin/suppliers', {
      requestId: randomUUID(),
      name: `Supplier ${randomUUID().slice(0, 6)}`,
      companyId: null,
      vatId: null,
    });
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    const document = await http()
      .post('/api/admin/supplier-documents')
      .set('Cookie', cookie)
      .field('requestId', randomUUID())
      .field('supplierId', supplier.body.id)
      .field('kind', 'DELIVERY_NOTE')
      .field('documentNumber', `DL-${randomUUID().slice(0, 6)}`)
      .field('issuedOn', '2026-10-11')
      .attach('file', PDF_BYTES, 'dl.pdf')
      .expect(201);
    const receipt = await as(cookie).post('/api/admin/goods-receipts', {
      requestId: randomUUID(),
      supplierId: supplier.body.id,
      supplierReference: 'DL-1',
      receivedAt: new Date().toISOString(),
      note: null,
      documentIds: [document.body.id],
      lines: [
        {
          itemId: await newBottleItemId(t),
          quantity,
          supplierLotCode: null,
          unitPrice: null,
          currency: null,
          vatRate: null,
        },
      ],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    return receipt.body as GoodsReceipt;
  }

  const newBottles = (stock: StockOverview) =>
    stock.items.find((i) => i.item.code === 'NEW_BOTTLE')!.onHand;

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await t.prisma.user.create({
      data: { email: unique('site-admin'), displayName: 'Site Admin' },
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    const created = await as(admin).post('/api/admin/sites', {
      code: `DE-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Werk Deutschland',
      countryCode: 'DE',
      addressLine1: 'Musterstraße 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      timeZone: 'Europe/Berlin',
      defaultLocale: 'de-DE',
      defaultCurrency: 'EUR',
      capabilities: ['WAREHOUSE', 'PRODUCTION', 'RETURNS'],
      reason: 'future German facility',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    de = created.body as SiteDetail;
    await addWarehouse(de.id, `${de.code}-W`);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  describe('custom roles', () => {
    it('ADMIN creates a custom role from permissions; holders gain and lose access at once', async () => {
      const catalogue = (await as(admin).get('/api/admin/identity/permissions').expect(200)).body;
      expect(catalogue.find((p: { code: string }) => p.code === 'inventory:read')).toMatchObject({
        module: 'inventory',
        securityAdmin: false,
        warehouseScoped: true,
      });
      const code = `CLERK_${randomUUID().slice(0, 4).toUpperCase()}`;
      const created = await as(admin).post('/api/admin/identity/roles', {
        code,
        name: 'Příjemce zboží',
        description: 'Receives goods only',
        permissions: ['inventory:read', 'inventory:receive'],
        copiedFrom: 'WAREHOUSE_OPERATOR',
        reason: 'receiving clerk for the new hall',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const role = created.body as RoleDetail;
      expect(role).toMatchObject({ code, system: false, active: true, assignedUsers: 0 });
      expect(role.audit[0]).toMatchObject({
        type: 'ROLE_CREATED',
        reason: 'receiving clerk for the new hall',
        details: { copiedFrom: 'WAREHOUSE_OPERATOR' },
      });

      const { user, cookie } = await createUser([code], [INITIAL_SITE_ID]);
      expect(user.effectiveAccess.permissions).toEqual(['inventory:read', 'inventory:receive']);
      await as(cookie).get('/api/admin/inventory/stock').expect(200);
      const me = (await as(cookie).get('/api/auth/me').expect(200)).body as CurrentUser;
      expect(me.roles).toEqual([{ code, name: 'Příjemce zboží' }]);

      // Editing the role takes effect on the holder's very next request.
      const edited = await as(admin).post(`/api/admin/identity/roles/${role.id}`, {
        name: 'Příjemce zboží (jen příjem)',
        description: 'Receives goods; no stock overview',
        permissions: ['inventory:receive'],
        reason: 'stock overview is not needed',
      });
      expect(edited.status).toBe(200);
      expect(edited.body.audit[0]).toMatchObject({
        type: 'ROLE_UPDATED',
        details: { removed: ['inventory:read'], added: [], holders: 1 },
      });
      expect((await as(cookie).get('/api/admin/inventory/stock')).status).toBe(403);

      // A role still held cannot be deactivated; after the removal it can, and is no longer
      // grantable.
      const inUse = await as(admin).post(`/api/admin/identity/roles/${role.id}/deactivate`, {
        reason: 'no longer needed',
      });
      expect(inUse.status).toBe(409);
      expect(inUse.body.code).toBe('ROLE_IN_USE');
      await as(admin)
        .post(`/api/admin/identity/users/${user.id}/roles/revoke`, {
          role: code,
          reason: 'moved to another role',
        })
        .expect(200);
      await as(admin)
        .post(`/api/admin/identity/roles/${role.id}/deactivate`, { reason: 'no longer needed' })
        .expect(200);
      const grant = await as(admin).post(`/api/admin/identity/users/${user.id}/roles/grant`, {
        role: code,
        reason: 'try again',
      });
      expect(grant.body.code).toBe('ROLE_INACTIVE');
    });

    it('system roles are templates: never renamed, edited or deactivated through the API', async () => {
      const roles = (await as(admin).get('/api/admin/identity/roles').expect(200)).body as {
        id: string;
        code: string;
        system: boolean;
      }[];
      const sales = roles.find((r) => r.code === 'SALES')!;
      expect(sales.system).toBe(true);
      const rename = await as(admin).post(`/api/admin/identity/roles/${sales.id}`, {
        name: 'Prodej',
        description: '',
        permissions: ['inventory:stock_summary'],
        reason: 'rename attempt',
      });
      expect(rename.status).toBe(409);
      expect(rename.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      const off = await as(admin).post(`/api/admin/identity/roles/${sales.id}/deactivate`, {
        reason: 'attempt',
      });
      expect(off.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      const clash = await as(admin).post('/api/admin/identity/roles', {
        code: 'ADMIN',
        name: 'Fake admin',
        description: '',
        permissions: [],
        reason: 'code clash',
      });
      expect(clash.body.code).toBe('ROLE_EXISTS');
    });

    it('custom roles never hold security administration, unknown or obsolete permissions', async () => {
      const base = { name: 'X', description: '', reason: 'validation test' };
      const security = await as(admin).post('/api/admin/identity/roles', {
        ...base,
        code: `SEC_${randomUUID().slice(0, 4).toUpperCase()}`,
        permissions: ['inventory:read', 'identity:users_manage'],
      });
      expect(security.status).toBe(422);
      expect(security.body.code).toBe('SECURITY_PERMISSION_RESERVED');
      const unknown = await as(admin).post('/api/admin/identity/roles', {
        ...base,
        code: `UNK_${randomUUID().slice(0, 4).toUpperCase()}`,
        permissions: ['inventory:teleport'],
      });
      expect(unknown.status).toBe(400);
      // The database refuses it too, whatever the application does.
      const code = `RAW_${randomUUID().slice(0, 4).toUpperCase()}`;
      await t.prisma.role.create({ data: { code, name: 'Raw', description: '' } });
      await expect(
        t.prisma.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code")
          VALUES (${code}, 'sites:all_access')`,
      ).rejects.toThrow(/security-administration/);
    });

    it('only ADMIN changes roles and assignments; nobody escalates through the API', async () => {
      const { user, cookie } = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
      const attempts = [
        as(cookie).post('/api/admin/identity/roles', {
          code: 'MY_ROLE',
          name: 'Mine',
          description: '',
          permissions: ['inventory:read'],
          reason: 'self service',
        }),
        as(cookie).post(`/api/admin/identity/users/${user.id}/roles/grant`, {
          role: 'ADMIN',
          reason: 'self promotion',
        }),
        as(cookie).post(`/api/admin/identity/users/${user.id}/sites/grant`, {
          siteId: de.id,
          reason: 'self service',
        }),
        as(cookie).post('/api/admin/sites', {}),
        as(cookie).get('/api/admin/identity/permissions'),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('sites', () => {
    it('ADMIN creates and edits sites with validation, reasons and audit', async () => {
      const bad = await as(admin).post('/api/admin/sites', {
        code: 'XX-1',
        name: 'Bad',
        countryCode: 'cz',
        addressLine1: 'A',
        addressLine2: null,
        postalCode: '1',
        city: 'C',
        timeZone: 'Mars/Olympus',
        defaultLocale: 'cs',
        defaultCurrency: 'czk',
        capabilities: ['WAREHOUSE'],
        reason: 'invalid',
      });
      expect(bad.status).toBe(400);
      const dup = await as(admin).post('/api/admin/sites', {
        code: de.code,
        name: 'Dup',
        countryCode: 'DE',
        addressLine1: 'A 1',
        addressLine2: null,
        postalCode: '1',
        city: 'C',
        timeZone: 'Europe/Berlin',
        defaultLocale: 'de-DE',
        defaultCurrency: 'EUR',
        capabilities: [],
        reason: 'duplicate',
      });
      expect(dup.body.code).toBe('SITE_EXISTS');

      const initial = (await as(admin).get(`/api/admin/sites/${INITIAL_SITE_ID}`).expect(200))
        .body as SiteDetail;
      expect(initial).toMatchObject({
        code: 'SITE-1',
        countryCode: 'CZ',
        timeZone: 'Europe/Prague',
        addressComplete: false,
        warehouses: [{ code: 'MAIN', default: true }],
      });
      const removeWarehouse = await as(admin).post(`/api/admin/sites/${INITIAL_SITE_ID}`, {
        name: initial.name,
        countryCode: 'CZ',
        addressLine1: 'Ulice 1',
        addressLine2: null,
        postalCode: '110 00',
        city: 'Praha',
        timeZone: 'Europe/Prague',
        defaultLocale: 'cs-CZ',
        defaultCurrency: 'CZK',
        capabilities: ['PRODUCTION'],
        reason: 'drop warehouse',
      });
      expect(removeWarehouse.body.code).toBe('SITE_HAS_WAREHOUSES');

      const edited = await as(admin).post(`/api/admin/sites/${de.id}`, {
        name: 'Werk Berlin',
        countryCode: 'DE',
        addressLine1: 'Musterstraße 2',
        addressLine2: 'Halle B',
        postalCode: '10115',
        city: 'Berlin',
        timeZone: 'Europe/Berlin',
        defaultLocale: 'de-DE',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE', 'PRODUCTION', 'RETURNS'],
        reason: 'address confirmed',
      });
      expect(edited.status).toBe(200);
      expect(edited.body.audit[0]).toMatchObject({
        type: 'SITE_UPDATED',
        site: de.code,
        reason: 'address confirmed',
      });
      expect(edited.body.audit[0].details.changed).toEqual(
        expect.arrayContaining(['name', 'addressLine1', 'addressLine2']),
      );
      // Codes are stable identifiers; the database refuses a change.
      await expect(
        t.prisma.$executeRaw`UPDATE "sites" SET "code" = 'DE-NEW' WHERE "id" = ${de.id}::uuid`,
      ).rejects.toThrow(/immutable/);
      await expect(
        t.prisma.$executeRaw`DELETE FROM "sites" WHERE "id" = ${de.id}::uuid`,
      ).rejects.toThrow(/not allowed/);
      await expect(
        t.prisma
          .$executeRaw`UPDATE "sites" SET "time_zone" = 'Mars/Olympus' WHERE "id" = ${de.id}::uuid`,
      ).rejects.toThrow(/time zone/);
    });

    it('a deactivated site keeps its history readable and refuses new operational writes', async () => {
      const pl = (
        await as(admin).post('/api/admin/sites', {
          code: `PL-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Zakład Polska',
          countryCode: 'PL',
          addressLine1: 'Ulica 1',
          addressLine2: null,
          postalCode: '00-001',
          city: 'Warszawa',
          timeZone: 'Europe/Warsaw',
          defaultLocale: 'pl-PL',
          defaultCurrency: 'PLN',
          capabilities: ['WAREHOUSE'],
          reason: 'pilot',
        })
      ).body as SiteDetail;
      await addWarehouse(pl.id, `${pl.code}-W`);
      const { cookie } = await createUser(['WAREHOUSE_SUPERVISOR'], [pl.id]);
      await receive(cookie, '3');

      // With stock on hand the site cannot be deactivated; the blocker is shown in advance.
      const blocked = (await as(admin).get(`/api/admin/sites/${pl.id}`)).body as SiteDetail;
      expect(blocked.deactivationBlockers.map((b) => b.code)).toEqual(['STOCK_ON_HAND']);
      const refused = await as(admin).post(`/api/admin/sites/${pl.id}/deactivate`, {
        reason: 'closing',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('SITE_DEPENDENCIES');

      // Without stock (a site never used) it can be deactivated: reads stay, writes stop.
      const empty = (
        await as(admin).post('/api/admin/sites', {
          code: `AT-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Werk Österreich',
          countryCode: 'AT',
          addressLine1: 'Gasse 1',
          addressLine2: null,
          postalCode: '1010',
          city: 'Wien',
          timeZone: 'Europe/Vienna',
          defaultLocale: 'de-AT',
          defaultCurrency: 'EUR',
          capabilities: ['WAREHOUSE'],
          reason: 'planned',
        })
      ).body as SiteDetail;
      await addWarehouse(empty.id, `${empty.code}-W`);
      const at = await createUser(['WAREHOUSE_SUPERVISOR'], [empty.id]);
      await as(admin)
        .post(`/api/admin/sites/${empty.id}/deactivate`, { reason: 'plan postponed' })
        .expect(200);
      await as(at.cookie).get('/api/admin/inventory/stock').expect(200);
      await as(at.cookie).get('/api/admin/goods-receipts').expect(200);
      const write = await as(at.cookie).post('/api/admin/suppliers', {
        requestId: randomUUID(),
        name: 'Nope',
        companyId: null,
        vatId: null,
      });
      expect(write.status).toBe(409);
      expect(write.body.code).toBe('SITE_INACTIVE');
      const detail = (await as(admin).get(`/api/admin/sites/${empty.id}`)).body as SiteDetail;
      expect(detail.active).toBe(false);
      expect(detail.audit.map((a) => a.type)).toContain('SITE_DEACTIVATED');
      await as(admin)
        .post(`/api/admin/sites/${empty.id}/reactivate`, { reason: 'plan resumed' })
        .expect(200);
    });
  });

  describe('multi-site isolation', () => {
    it('a user of one site never reaches another site, whatever the request claims', async () => {
      const cz = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
      const ger = await createUser(['WAREHOUSE_SUPERVISOR'], [de.id]);
      const czMe = (await as(cz.cookie).get('/api/auth/me')).body as CurrentUser;
      expect(czMe.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);
      expect(czMe.activeSiteId).toBe(INITIAL_SITE_ID);

      const deReceipt = await receive(ger.cookie, '7');
      const czReceipt = await receive(cz.cookie, '2');
      const deStock = (await as(ger.cookie).get('/api/admin/inventory/stock')).body;
      expect(deStock.location.code).toBe(`${de.code}-W`);
      expect(newBottles(deStock)).toBe('7');

      // Another site's receipt does not exist for this user — not by code, list or movements.
      expect((await as(cz.cookie).get(`/api/admin/goods-receipts/${deReceipt.code}`)).status).toBe(
        404,
      );
      const czList = (await as(cz.cookie).get('/api/admin/goods-receipts?pageSize=100')).body;
      expect(czList.items.map((r: { code: string }) => r.code)).toContain(czReceipt.code);
      expect(czList.items.map((r: { code: string }) => r.code)).not.toContain(deReceipt.code);
      const czMoves = JSON.stringify(
        (await as(cz.cookie).get('/api/admin/inventory/movements?pageSize=100')).body,
      );
      expect(czMoves).not.toContain(deReceipt.code);
      // Nor can it act on it.
      const correct = await as(cz.cookie).post(
        `/api/admin/goods-receipts/${deReceipt.code}/corrections`,
        { requestId: randomUUID(), lineNo: 1, quantityDelta: '-1', reason: 'cross-site attempt' },
      );
      expect(correct.status).toBe(404);

      // A forged site selection is refused and audited; site ids elsewhere are ignored.
      const forged = await as(cz.cookie).post('/api/auth/active-site', { siteId: de.id });
      expect(forged.status).toBe(403);
      expect(forged.body.code).toBe('SITE_FORBIDDEN');
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'ACTIVE_SITE_SELECTED', targetUserId: cz.user.id },
        }),
      ).toBe(1);
      const spoofed = await http()
        .get('/api/admin/inventory/stock')
        .query({ siteId: de.id, site: de.code })
        .set('Cookie', `${cz.cookie}; ayvo_site=${de.id}`)
        .set('X-AYVO-Site', de.id)
        .set('X-Site-Id', de.id);
      expect(spoofed.body.location.code).toBe('MAIN');
    });

    it('a multi-site user chooses the active site; switching shows only that site’s data', async () => {
      const multi = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID, de.id]);
      const me = (await as(multi.cookie).get('/api/auth/me')).body as CurrentUser;
      expect(me.sites.map((s) => s.id).sort()).toEqual([INITIAL_SITE_ID, de.id].sort());
      expect(me.activeSiteId).toBeNull();
      const none = await as(multi.cookie).get('/api/admin/inventory/stock');
      expect(none.status).toBe(403);
      expect(none.body.code).toBe('SITE_REQUIRED');

      await as(multi.cookie).post('/api/auth/active-site', { siteId: de.id }).expect(200);
      const atDe = (await as(multi.cookie).get('/api/admin/inventory/stock')).body as StockOverview;
      await as(multi.cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
      const atCz = (await as(multi.cookie).get('/api/admin/inventory/stock')).body as StockOverview;
      expect(atDe.location.code).toBe(`${de.code}-W`);
      expect(atCz.location.code).toBe('MAIN');
      expect(newBottles(atDe)).toBe('7');
      expect(newBottles(atCz)).not.toBe(newBottles(atDe));

      // Losing the site ends access to it at once, even for the session that selected it.
      await as(multi.cookie).post('/api/auth/active-site', { siteId: de.id }).expect(200);
      await as(admin)
        .post(`/api/admin/identity/users/${multi.user.id}/sites/revoke`, {
          siteId: de.id,
          reason: 'transferred to Prague',
        })
        .expect(200);
      const after = (await as(multi.cookie).get('/api/auth/me')).body as CurrentUser;
      expect(after.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);
      expect(after.activeSiteId).toBe(INITIAL_SITE_ID);
      expect((await as(multi.cookie).get('/api/admin/inventory/stock')).body.location.code).toBe(
        'MAIN',
      );
    });

    it('warehouses only narrow an allowed site; a warehouse outside it is refused', async () => {
      const czExtra = `CZB-${randomUUID().slice(0, 4).toUpperCase()}`;
      await addWarehouse(INITIAL_SITE_ID, czExtra, false);
      // Narrowed to the extra hall: the site's operational warehouse (MAIN) is out of reach.
      const narrow = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID], [czExtra]);
      expect(narrow.user.effectiveAccess.sites[0]).toMatchObject({
        allWarehouses: false,
        warehouses: [{ code: czExtra }],
      });
      const stock = await as(narrow.cookie).get('/api/admin/inventory/stock');
      expect(stock.status).toBe(403);
      expect(stock.body.code).toBe('FORBIDDEN');

      // A warehouse of a site the user has no access to cannot be granted…
      const outside = await as(admin).post(
        `/api/admin/identity/users/${narrow.user.id}/warehouses/grant`,
        { warehouseCode: `${de.code}-W`, reason: 'outside attempt' },
      );
      expect(outside.status).toBe(422);
      expect(outside.body.code).toBe('SITE_ACCESS_REQUIRED');
      // …not even directly in the database.
      const deWarehouse = await t.prisma.inventoryLocation.findUniqueOrThrow({
        where: { code: `${de.code}-W` },
      });
      await expect(
        t.prisma.$executeRaw`INSERT INTO "user_scopes" ("user_id", "type", "location_id")
          VALUES (${narrow.user.id}::uuid, 'WAREHOUSE', ${deWarehouse.id}::uuid)`,
      ).rejects.toThrow(/needs access to its site/);

      // Site-specific audit events name their site.
      const scopeEvents = await t.prisma.auditEvent.findMany({
        where: { targetUserId: narrow.user.id, type: 'SCOPE_GRANTED' },
      });
      expect(scopeEvents.map((e) => e.siteId)).toEqual([INITIAL_SITE_ID, INITIAL_SITE_ID]);
    });

    it('ADMIN has global site access as an explicit permission, not as scope rows', async () => {
      const me = (await as(admin).get('/api/auth/me')).body as CurrentUser;
      expect(me.globalSiteAccess).toBe(true);
      expect(me.scopes).toEqual([]);
      expect(me.sites.map((s) => s.id)).toEqual(expect.arrayContaining([INITIAL_SITE_ID, de.id]));
      await as(admin).post('/api/auth/active-site', { siteId: de.id }).expect(200);
      expect((await as(admin).get('/api/admin/inventory/stock')).body.location.code).toBe(
        `${de.code}-W`,
      );
      // Label applications consume a site's stock: the list shows only the active site's.
      expect((await as(admin).get('/api/admin/label-applications')).body.items).toEqual([]);
    });
  });
});
