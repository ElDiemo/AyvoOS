import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  BottleRegistrationResponse,
  CurrentUser,
  GoodsReceipt,
  RoleDetail,
  SiteDetail,
  StockOverview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, sessionCookie } from './support/sign-in.js';
import { SVG_70x110 } from './support/artwork-fixtures.js';
import { layout } from './support/fixtures.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';
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

  async function receive(
    cookie: string,
    quantity: string,
    supplierId?: string,
  ): Promise<GoodsReceipt> {
    const supplier = supplierId
      ? { body: { id: supplierId } }
      : await as(cookie).post('/api/admin/suppliers', {
          requestId: randomUUID(),
          name: `Supplier ${randomUUID().slice(0, 6)}`,
          companyId: null,
          vatId: null,
        });
    if (!supplierId) expect((supplier as { status: number }).status).toBe(201);
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
        // The confirmed initial facility (owner decision 2026-10-12).
        code: 'CZ-PREROV-01',
        name: 'Přerov 1',
        countryCode: 'CZ',
        timeZone: 'Europe/Prague',
        defaultLocale: 'cs-CZ',
        defaultCurrency: 'CZK',
        capabilities: ['WAREHOUSE', 'PRODUCTION', 'RETURNS'],
        addressLine1: null,
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

  describe('cross-site production and purchasing (IDOR)', () => {
    let template: string;
    let cz: Awaited<ReturnType<typeof createUser>>;
    let ger: Awaited<ReturnType<typeof createUser>>;
    let czReg: BottleRegistrationResponse;
    let deReg: BottleRegistrationResponse;
    let deBottle: { code: string; publicToken: string };

    const register = async (cookie: string, quantity: number) => {
      const res = await as(cookie).post('/api/admin/bottle-registrations', {
        requestId: randomUUID(),
        labelTemplateVersionId: template,
        quantity,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as BottleRegistrationResponse;
    };

    beforeAll(async () => {
      // Label templates are company-wide brand data, managed by ADMIN.
      const artwork = await http()
        .post('/api/admin/label-artworks')
        .set('Cookie', admin)
        .attach('file', SVG_70x110, 'artwork.svg')
        .expect(201);
      template = (
        await as(admin)
          .post('/api/admin/label-templates', {
            name: `site-tpl-${randomUUID().slice(0, 6)}`,
            layout: layout(artwork.body.id),
          })
          .expect(201)
      ).body.versionId;
      cz = await createUser(['PRODUCTION_SUPERVISOR', 'WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
      ger = await createUser(['PRODUCTION_SUPERVISOR', 'WAREHOUSE_SUPERVISOR'], [de.id]);
      czReg = await register(cz.cookie, 2);
      deReg = await register(ger.cookie, 1);
      await as(ger.cookie)
        .post(`/api/admin/label-print-jobs/${deReg.printJob!.code}/generate`)
        .expect(200);
      deBottle = await t.prisma.bottle.findFirstOrThrow({
        where: { creationBatch: { code: deReg.batch.code } },
        select: { code: true, publicToken: true },
      });
    });

    it('series, bottles and print jobs of another site cannot be listed, opened, printed or changed', async () => {
      const czList = JSON.stringify(
        (await as(cz.cookie).get('/api/admin/bottles?pageSize=100')).body,
      );
      expect(czList).not.toContain(deBottle.code);
      for (const path of [
        '/api/admin/bottle-batches?pageSize=100',
        '/api/admin/bottle-creation-history?pageSize=100',
      ]) {
        const body = JSON.stringify((await as(cz.cookie).get(path).expect(200)).body);
        expect(body, path).toContain(czReg.batch.code);
        expect(body, path).not.toContain(deReg.batch.code);
      }
      const de = deReg.batch.code;
      const job = deReg.printJob!.code;
      for (const [method, path] of [
        ['GET', `/api/admin/bottles/${deBottle.code}`],
        ['GET', `/api/admin/bottles/${deBottle.code}/physical`],
        ['GET', `/api/admin/bottle-batches/${de}`],
        ['GET', `/api/admin/bottle-batches/${de}/print-jobs`],
        ['POST', `/api/admin/bottle-batches/${de}/print-jobs`],
        ['GET', `/api/admin/label-print-jobs/${job}`],
        ['POST', `/api/admin/label-print-jobs/${job}/generate`],
        ['GET', `/api/admin/label-print-jobs/${job}/pdf`],
      ] as const) {
        const res =
          method === 'GET' ? await as(cz.cookie).get(path) : await as(cz.cookie).post(path);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      // The owning site sees its own records.
      await as(ger.cookie).get(`/api/admin/bottles/${deBottle.code}`).expect(200);
      await as(ger.cookie).get(`/api/admin/label-print-jobs/${job}/pdf`).expect(200);
      // Replaying another site's registration request reveals nothing.
      const replay = await as(cz.cookie).post('/api/admin/bottle-registrations', {
        requestId: (await t.prisma.bottleCreationBatch.findUniqueOrThrow({ where: { code: de } }))
          .clientRequestId,
        labelTemplateVersionId: template,
        quantity: 1,
      });
      expect(replay.status).toBe(409);
      expect(JSON.stringify(replay.body)).not.toContain(de);
      // No implicit transfer: the database refuses to move a bottle or print job.
      await expect(
        t.prisma
          .$executeRaw`UPDATE "bottles" SET "site_id" = ${INITIAL_SITE_ID}::uuid WHERE "code" = ${deBottle.code}`,
      ).rejects.toThrow(/never changes|violates foreign key/);
    });

    it('a bottle is labelled only at its own site', async () => {
      const lot = (await receive(cz.cookie, '5')).lines[0]!.lot!;
      const res = await as(cz.cookie).post('/api/admin/label-applications', {
        requestId: randomUUID(),
        lotId: lot.id,
        seriesCode: deReg.batch.code,
        scannedValue: `${TEST_QR_BASE_URL}/${deBottle.publicToken}`,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('BOTTLE_OF_ANOTHER_SITE');
    });

    it('templates are global brand data: readable at every site, changed only with the global permission', async () => {
      const list = await as(cz.cookie).get('/api/admin/label-templates').expect(200);
      expect(JSON.stringify(list.body)).toContain(template);
      const create = await as(cz.cookie).post('/api/admin/label-templates', {
        name: 'site supervisor template',
        layout: layout(randomUUID()),
      });
      expect(create.status).toBe(403);
    });

    it('the public passport stays public and reveals no site, warehouse or operation', async () => {
      const passport = await http().get(`/api/public/bottles/${deBottle.publicToken}`).expect(200);
      const text = JSON.stringify(passport.body);
      for (const secret of [de.code, `${de.code}-W`, de.id, 'site', 'warehouse', 'lot']) {
        expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    });

    it('documents, receipts and prices of another site are out of reach by id or code', async () => {
      const deReceipt = await receive(ger.cookie, '2');
      const deDoc = deReceipt.documents![0]!;
      const finance = await createUser(['FINANCE'], [INITIAL_SITE_ID]);
      for (const cookie of [finance.cookie, cz.cookie]) {
        expect((await as(cookie).get(deDoc.contentUrl)).status).toBe(404);
        expect((await as(cookie).get(`/api/admin/goods-receipts/${deReceipt.code}`)).status).toBe(
          404,
        );
        const docs = JSON.stringify(
          (await as(cookie).get(`/api/admin/suppliers/${deDoc.supplierId}/documents`)).body,
        );
        expect(docs).not.toContain(deDoc.id);
      }
      const cost = await as(finance.cookie).post(
        `/api/admin/goods-receipts/${deReceipt.code}/lines/1/cost`,
        { requestId: randomUUID(), unitPrice: '1', currency: 'EUR', vatRate: null, reason: 'idor' },
      );
      expect(cost.status).toBe(404);
      // Another site's document cannot be attached to this site's receipt or new receipts.
      const czReceipt = await receive(cz.cookie, '1', deDoc.supplierId);
      const link = await as(cz.cookie).post(
        `/api/admin/goods-receipts/${czReceipt.code}/documents`,
        {
          requestId: randomUUID(),
          documentId: deDoc.id,
        },
      );
      expect(link.status).toBe(422);
      // FINANCE at the German site sees German values; not the Czech ones.
      const deFinance = await createUser(['FINANCE'], [de.id]);
      await as(deFinance.cookie).get(`/api/admin/goods-receipts/${deReceipt.code}`).expect(200);
      expect(
        (await as(deFinance.cookie).get(`/api/admin/goods-receipts/${czReceipt.code}`)).status,
      ).toBe(404);
      // The database keeps a receipt's documents at its site, whatever the application does.
      await expect(
        t.prisma
          .$executeRaw`INSERT INTO "goods_receipt_documents" ("receipt_id", "document_id", "request_id")
          SELECT r."id", ${deDoc.id}::uuid, ${randomUUID()}::uuid FROM "goods_receipts" r WHERE r."code" = ${czReceipt.code}`,
      ).rejects.toThrow(/its own site/);
    });
  });

  describe('multi-site isolation', () => {
    it('a user of one site never reaches another site, whatever the request claims', async () => {
      const cz = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
      const ger = await createUser(['WAREHOUSE_SUPERVISOR'], [de.id]);
      const czMe = (await as(cz.cookie).get('/api/auth/me')).body as CurrentUser;
      expect(czMe.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);
      expect(czMe.activeSiteId).toBe(INITIAL_SITE_ID);

      const before = newBottles((await as(ger.cookie).get('/api/admin/inventory/stock')).body);
      const deReceipt = await receive(ger.cookie, '7');
      const czReceipt = await receive(cz.cookie, '2');
      const deStock = (await as(ger.cookie).get('/api/admin/inventory/stock')).body;
      expect(deStock.location.code).toBe(`${de.code}-W`);
      expect(Number(newBottles(deStock)) - Number(before)).toBe(7);

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
      // Each view equals what a user of only that site sees.
      const deOnly = await createUser(['WAREHOUSE_SUPERVISOR'], [de.id]);
      const czOnly = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);
      expect(newBottles(atDe)).toBe(
        newBottles((await as(deOnly.cookie).get('/api/admin/inventory/stock')).body),
      );
      expect(newBottles(atCz)).toBe(
        newBottles((await as(czOnly.cookie).get('/api/admin/inventory/stock')).body),
      );
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
