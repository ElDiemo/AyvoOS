import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  CatalogComponent,
  CrateType,
  MaterialRequirements,
  Product,
  RecipeVersion,
} from '@ayvo/types';
import { inventoryItemSchema } from '@ayvo/types';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

/**
 * Product catalogue and recipes v0.1 (doc 023) through the real guard, sessions and database:
 * components and products, the draft → active → archived lifecycle of recipe versions, the one
 * active version per product (also under concurrency), validation, authorization and reasons,
 * idempotency, the exact material calculation, the database invariants on their own, and — above
 * all — that nothing here touches stock: ledger, balances and lots stay byte-for-byte unchanged.
 */
describe.skipIf(!hasDatabase)('product catalogue and recipes', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  const sfx = () => randomUUID().slice(0, 6).toUpperCase();
  const http = () => request(t.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
    put: (path: string, body: object = {}) => http().put(path).set('Cookie', cookie).send(body),
  });
  const api = '/api/admin/catalog';

  // --- fixtures ----------------------------------------------------------------------------------

  async function component(
    body: Partial<Record<string, unknown>> & { kind: string },
  ): Promise<CatalogComponent> {
    const res = await as(admin).post(`${api}/components`, {
      requestId: randomUUID(),
      code: `${body.kind.slice(0, 6)}-${sfx()}`,
      name: `Komponenta ${body.kind}`,
      unitCode: body.kind === 'BULK_LIQUID' ? 'ml' : 'pcs',
      lotTracked: true,
      categoryCode: null,
      packageCapacity: null,
      reason: 'katalog pro test',
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as CatalogComponent;
  }

  async function crateType(categoryCodes = ['HAND_SOAP'], capacity = 40): Promise<CrateType> {
    const res = await as(admin).post(`${api}/crate-types`, {
      requestId: randomUUID(),
      code: `CRATE-${sfx()}`,
      name: 'Vratná výrobní bedna',
      capacity,
      categoryCodes,
      reason: 'typ bedny pro test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as CrateType;
  }

  async function product(categoryCode = 'HAND_SOAP'): Promise<Product> {
    const res = await as(admin).post(`${api}/products`, {
      requestId: randomUUID(),
      code: `SOAP-${sfx()}`,
      name: 'Tekuté mýdlo 330 ml',
      categoryCode,
      nominalQuantity: '330',
      nominalUnitCode: 'ml',
      reason: 'nový produkt',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Product;
  }

  /** One complete set of components and a crate type for a category (the owner's example). */
  async function kit(category = 'HAND_SOAP') {
    const [bottle, liquid, pump, label, crate] = await Promise.all([
      component({ kind: 'NEW_BOTTLE', name: 'Skleněná lahev 330 ml' }),
      component({ kind: 'BULK_LIQUID', name: 'Kapalina', categoryCode: category }),
      component({ kind: 'PUMP', name: 'Pumpička' }),
      // Label lot tracking is an open owner question (doc 023 §11); not tracked here.
      component({
        kind: 'LABEL_MEDIA',
        name: 'Etiketa',
        categoryCode: category,
        lotTracked: false,
      }),
      crateType([category]),
    ]);
    const lines = [
      { itemCode: bottle.code, quantity: '1', unitCode: 'pcs' },
      { itemCode: liquid.code, quantity: '330', unitCode: 'ml' },
      { itemCode: pump.code, quantity: '1', unitCode: 'pcs' },
      { itemCode: label.code, quantity: '1', unitCode: 'pcs' },
    ];
    return { bottle, liquid, pump, label, crate, lines };
  }

  const draft = (code: string, body: object, cookie = admin) =>
    as(cookie).post(`${api}/products/${code}/recipes`, {
      requestId: randomUUID(),
      reason: 'návrh kusovníku',
      ...body,
    });
  const activate = (code: string, version: number, expected: number | null, cookie = admin) =>
    as(cookie).post(`${api}/products/${code}/recipes/${version}/activate`, {
      requestId: randomUUID(),
      reason: 'schváleno',
      expectedActiveVersion: expected,
    });
  const archive = (code: string, version: number) =>
    as(admin).post(`${api}/products/${code}/recipes/${version}/archive`, {
      requestId: randomUUID(),
      reason: 'už se nepoužívá',
    });

  async function activeRecipe() {
    const k = await kit();
    const p = await product();
    const created = await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await activate(p.code, 1, null);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { k, p, recipe: res.body as RecipeVersion };
  }

  /** Stock: an md5 per table of every row in a fixed order — must never change here. */
  async function stockFingerprint() {
    const rows = await t.prisma.$queryRaw<{ t: string; n: bigint; h: string | null }[]>`
      SELECT 'movements' AS t, count(*) AS n, md5(string_agg(m::text, '|' ORDER BY m.id)) AS h
        FROM inventory_movements m
      UNION ALL SELECT 'balances', count(*), md5(string_agg(b::text, '|' ORDER BY b.id))
        FROM inventory_balances b
      UNION ALL SELECT 'lots', count(*), md5(string_agg(l::text, '|' ORDER BY l.id))
        FROM inventory_lots l
      UNION ALL SELECT 'locations', count(*), md5(string_agg(x::text, '|' ORDER BY x.id))
        FROM inventory_locations x
      UNION ALL SELECT 'receipts', count(*), md5(string_agg(g::text, '|' ORDER BY g.id))
        FROM goods_receipts g`;
    return Object.fromEntries(rows.map((r) => [r.t, `${r.n}:${r.h}`]));
  }

  /** Every catalogue row (for "a rejected operation leaves nothing behind"). */
  const catalogCounts = async () => ({
    items: await t.prisma.inventoryItem.count(),
    components: await t.prisma.catalogComponent.count(),
    crateTypes: await t.prisma.crateType.count(),
    products: await t.prisma.product.count(),
    recipes: await t.prisma.recipeVersion.count(),
    revisions: await t.prisma.recipeRevision.count(),
    boms: await t.prisma.bomVersion.count(),
    bomLines: await t.prisma.bomLine.count(),
    operations: await t.prisma.operationRequest.count(),
  });

  async function createUser(roles: string[]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `catalog-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Katalog Test',
      roles,
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'test setup',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    return sessionCookie(t, user.email);
  }

  let stockBefore: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: `catalog-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Catalog Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    stockBefore = await stockFingerprint();
  });

  afterAll(async () => {
    // Nothing in this file may have changed stock (the last word of every test above).
    if (t) {
      expect(await stockFingerprint()).toEqual(stockBefore);
      expect(await t.app.get(InventoryService).drift()).toEqual([]);
    }
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  // --- components, crate types, products ------------------------------------------------------------

  it('creates components without stock, audited with the reason', async () => {
    const before = await stockFingerprint();
    const liquid = await component({
      kind: 'BULK_LIQUID',
      name: 'Tekuté mýdlo – kapalina',
      categoryCode: 'HAND_SOAP',
    });
    expect(liquid).toEqual({
      code: liquid.code,
      name: 'Tekuté mýdlo – kapalina',
      kind: 'BULK_LIQUID',
      unit: { code: 'ml', name: 'mililitr', decimalPlaces: 3 },
      lotTracked: true,
      category: { code: 'HAND_SOAP', name: 'Tekuté mýdlo' },
      packageCapacity: null,
      archived: false,
    });
    // The shipping box: its capacity is not known — it stays unknown, never guessed.
    const box = await component({
      kind: 'PACKAGING',
      name: 'Přepravní krabice',
      lotTracked: false,
    });
    expect(box).toMatchObject({ kind: 'PACKAGING', packageCapacity: null, category: null });
    const sized = await component({ kind: 'PACKAGING', name: 'Krabice', packageCapacity: 12 });
    expect(sized.packageCapacity).toBe(12);

    const list = (await as(admin).get(`${api}/components`)).body as CatalogComponent[];
    expect(list.map((c) => c.code)).toEqual(expect.arrayContaining([liquid.code, box.code]));
    // The existing anonymous bottle body is a component too (no profile: any category).
    expect(list.find((c) => c.code === 'NEW_BOTTLE')).toMatchObject({
      kind: 'NEW_BOTTLE',
      category: null,
    });

    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: {
        type: 'CATALOG_COMPONENT_CREATED',
        payload: { path: ['component'], equals: liquid.code },
      },
    });
    expect(audit).toMatchObject({ actorUserId: adminId, reason: 'katalog pro test' });
    // A catalogue entry is never a receipt: no lot, balance or movement.
    const item = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: liquid.code } });
    expect(await t.prisma.inventoryLot.count({ where: { itemId: item.id } })).toBe(0);
    expect(await t.prisma.inventoryBalance.count({ where: { itemId: item.id } })).toBe(0);
    expect(await stockFingerprint()).toEqual(before);
  });

  it('refuses invalid components with a stable code and leaves nothing behind', async () => {
    const before = await catalogCounts();
    const base = {
      requestId: randomUUID(),
      code: `BAD-${sfx()}`,
      name: 'Špatná komponenta',
      lotTracked: false,
      packageCapacity: null,
      reason: 'test chyb',
    };
    const cases: [object, number, string?][] = [
      [
        { kind: 'BULK_LIQUID', unitCode: 'pcs', categoryCode: 'HAND_SOAP' },
        422,
        'UNIT_NOT_ALLOWED',
      ],
      [{ kind: 'PUMP', unitCode: 'ml', categoryCode: null }, 422, 'UNIT_NOT_ALLOWED'],
      [{ kind: 'PUMP', unitCode: 'roll', categoryCode: null }, 422, 'UNIT_NOT_ALLOWED'],
      [{ kind: 'PUMP', unitCode: 'kg', categoryCode: null }, 422, 'UNKNOWN_UNIT'],
      [{ kind: 'BULK_LIQUID', unitCode: 'ml', categoryCode: null }, 422, 'CATEGORY_REQUIRED'],
      // A label may be the shared blank stock (no category) — but never measured otherwise.
      [{ kind: 'LABEL_MEDIA', unitCode: 'roll', categoryCode: null }, 422, 'UNIT_NOT_ALLOWED'],
      [
        { kind: 'BULK_LIQUID', unitCode: 'ml', categoryCode: 'HAND_SOAP', packageCapacity: 300 },
        422,
        'PACKAGE_CAPACITY_NOT_ALLOWED',
      ],
      [{ kind: 'LABEL_MEDIA', unitCode: 'pcs', categoryCode: 'NO_SUCH' }, 422, 'UNKNOWN_CATEGORY'],
      [
        { kind: 'PUMP', unitCode: 'pcs', categoryCode: null, packageCapacity: 40 },
        422,
        'PACKAGE_CAPACITY_NOT_ALLOWED',
      ],
      [
        { kind: 'PUMP', unitCode: 'pcs', categoryCode: null, code: 'NEW_BOTTLE' },
        409,
        'CODE_TAKEN',
      ],
      [{ kind: 'COMPONENT', unitCode: 'pcs', categoryCode: null }, 400],
      [{ kind: 'PACKAGING', unitCode: 'pcs', categoryCode: null, packageCapacity: 0 }, 400],
      [{ kind: 'PUMP', unitCode: 'pcs', categoryCode: null, reason: ' x ' }, 400],
      [{ kind: 'NEW_BOTTLE', unitCode: 'pcs', categoryCode: null }, 422, 'LOT_TRACKING_REQUIRED'],
      [{ kind: 'PUMP', unitCode: 'pcs', categoryCode: null, name: 'P'.repeat(121) }, 400],
    ];
    for (const [patch, status, code] of cases) {
      const res = await as(admin).post(`${api}/components`, {
        ...base,
        ...patch,
        requestId: randomUUID(),
      });
      expect(res.status, JSON.stringify(patch)).toBe(status);
      if (code) expect(res.body.code, JSON.stringify(patch)).toBe(code);
      // Never a database message or a stack trace.
      expect(JSON.stringify(res.body)).not.toMatch(/AYVO:|prisma|SELECT|INSERT|constraint/i);
    }
    expect(await catalogCounts()).toEqual(before);
  });

  it('creates crate types with their capacity as data and products with a nominal quantity', async () => {
    const crate = await crateType(['HAND_SOAP', 'SHOWER_GEL'], 40);
    expect(crate).toEqual({
      code: crate.code,
      name: 'Vratná výrobní bedna',
      capacity: 40,
      categories: [
        { code: 'HAND_SOAP', name: 'Tekuté mýdlo' },
        { code: 'SHOWER_GEL', name: 'Sprchový gel' },
      ],
    });
    const p = await product('SHOWER_GEL');
    expect(p).toMatchObject({
      name: 'Tekuté mýdlo 330 ml',
      category: { code: 'SHOWER_GEL' },
      nominalQuantity: '330',
      nominalUnit: { code: 'ml' },
      activeVersion: null,
      versions: [],
    });
    expect((await as(admin).get(`${api}/products/${p.code}`)).body).toEqual(p);
    // The reference units for the forms (read-only, catalog:read): exactly the seeded ones.
    const units = (await as(admin).get(`${api}/units`)).body as {
      code: string;
      dimension: string;
    }[];
    expect(units.map((u) => `${u.code}:${u.dimension}`)).toEqual(
      expect.arrayContaining(['pcs:COUNT', 'ml:VOLUME']),
    );
    expect((await http().get(`${api}/units`)).status).toBe(401);
    expect((await as(admin).get(`${api}/categories`)).body).toEqual([
      { code: 'HAND_SOAP', name: 'Tekuté mýdlo' },
      { code: 'SHOWER_GEL', name: 'Sprchový gel' },
    ]);

    const bad = (patch: object) =>
      as(admin).post(`${api}/products`, {
        requestId: randomUUID(),
        code: `P-${sfx()}`,
        name: 'X',
        categoryCode: 'HAND_SOAP',
        nominalQuantity: '330',
        nominalUnitCode: 'ml',
        reason: 'test chyb',
        ...patch,
      });
    expect((await bad({ categoryCode: 'NO_SUCH' })).body.code).toBe('UNKNOWN_CATEGORY');
    expect((await bad({ nominalUnitCode: 'pcs', nominalQuantity: '1.5' })).body.code).toBe(
      'INVALID_QUANTITY',
    );
    expect((await bad({ code: p.code })).status).toBe(409);
    expect((await bad({ nominalQuantity: '0' })).status).toBe(400);
    expect((await bad({ nominalQuantity: '-330' })).status).toBe(400);
    expect((await bad({ code: 'A'.repeat(25) })).status).toBe(400);
    const crateBad = await as(admin).post(`${api}/crate-types`, {
      requestId: randomUUID(),
      code: `CRATE-${sfx()}`,
      name: 'Bedna',
      capacity: 40,
      categoryCodes: ['NO_SUCH'],
      reason: 'test chyb',
    });
    expect(crateBad.body.code).toBe('UNKNOWN_CATEGORY');
  });

  // --- recipe lifecycle --------------------------------------------------------------------------

  it('draft → active → new version → active again → archive; history stays readable', async () => {
    const k = await kit();
    const p = await product();

    // An incomplete draft is allowed and says what it still needs.
    const first = await draft(p.code, { crateTypeCode: null, components: k.lines.slice(0, 2) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ version: 1, status: 'DRAFT', revision: 1 });
    expect((first.body as RecipeVersion).missing).toEqual(['LABEL_MEDIA', 'PUMP', 'CRATE_TYPE']);
    const incomplete = await activate(p.code, 1, null);
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.code).toBe('RECIPE_INCOMPLETE');
    expect(
      (await as(admin).get(`${api}/products/${p.code}/recipes/1/requirements?bottles=40`)).body
        .code,
    ).toBe('RECIPE_INCOMPLETE');

    // Completing the draft appends revision 2; revision 1 stays in the database.
    const edited = await as(admin).put(`${api}/products/${p.code}/recipes/1`, {
      requestId: randomUUID(),
      reason: 'doplnění kusovníku',
      crateTypeCode: k.crate.code,
      components: k.lines,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const v1 = edited.body as RecipeVersion;
    expect(v1).toMatchObject({ status: 'DRAFT', revision: 2, missing: [] });
    expect(v1.components.map((c) => [c.kind, c.stage, c.quantity, c.unit.code])).toEqual([
      ['NEW_BOTTLE', 'LABEL_APPLICATION', '1', 'pcs'],
      ['LABEL_MEDIA', 'LABEL_APPLICATION', '1', 'pcs'],
      ['BULK_LIQUID', 'FILL', '330', 'ml'],
      ['PUMP', 'FILL', '1', 'pcs'],
    ]);
    const unchanged = await as(admin).put(`${api}/products/${p.code}/recipes/1`, {
      requestId: randomUUID(),
      reason: 'beze změny',
      crateTypeCode: k.crate.code,
      components: [...k.lines].reverse(),
    });
    expect(unchanged.body.code).toBe('NO_CHANGES');

    const active = await activate(p.code, 1, null);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({ version: 1, status: 'ACTIVE', revision: 2 });

    // The active version never changes: a change is a new version.
    const frozen = await as(admin).put(`${api}/products/${p.code}/recipes/1`, {
      requestId: randomUUID(),
      reason: 'přepis aktivní verze',
      crateTypeCode: k.crate.code,
      components: k.lines.map((l) => (l.unitCode === 'ml' ? { ...l, quantity: '300' } : l)),
    });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('RECIPE_NOT_DRAFT');

    const v2 = await draft(p.code, { basedOnVersion: 1 });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, status: 'DRAFT', basedOnVersion: 1, revision: 1 });
    expect((v2.body as RecipeVersion).components).toEqual(v1.components);
    const changed = await as(admin).put(`${api}/products/${p.code}/recipes/2`, {
      requestId: randomUUID(),
      reason: 'menší náplň',
      crateTypeCode: k.crate.code,
      components: k.lines.map((l) => (l.unitCode === 'ml' ? { ...l, quantity: '300.5' } : l)),
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // Activating v2 with a stale expectation is refused; with the right one, v1 is archived.
    expect((await activate(p.code, 2, null)).body.code).toBe('ACTIVE_VERSION_CHANGED');
    const swapped = await activate(p.code, 2, 1);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const after = (await as(admin).get(`${api}/products/${p.code}`)).body as Product;
    expect(after.activeVersion).toBe(2);
    expect(after.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'ARCHIVED'],
      [2, 'ACTIVE'],
    ]);
    // The archived version keeps its exact content and still calculates (history).
    const old = (await as(admin).get(`${api}/products/${p.code}/recipes/1`)).body as RecipeVersion;
    expect(old.components).toEqual(v1.components);
    expect(old.activatedAt).not.toBeNull();
    const oldCalc = await as(admin).get(
      `${api}/products/${p.code}/recipes/1/requirements?bottles=2`,
    );
    expect(oldCalc.status).toBe(200);

    // Archiving the active version leaves the product without one; archiving twice is refused.
    expect((await archive(p.code, 2)).body.status).toBe('ARCHIVED');
    expect((await archive(p.code, 2)).body.code).toBe('RECIPE_ARCHIVED');
    expect(
      ((await as(admin).get(`${api}/products/${p.code}`)).body as Product).activeVersion,
    ).toBeNull();
    expect((await activate(p.code, 2, null)).body.code).toBe('RECIPE_NOT_DRAFT');

    // Audit: every change with its reason; the swap archived v1 under the same request.
    const types = (
      await t.prisma.auditEvent.findMany({
        where: { type: { startsWith: 'RECIPE_' }, payload: { path: ['product'], equals: p.code } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })
    ).map((a) => `${a.type}:${(a.payload as { version: number }).version}:${a.reason}`);
    expect(types).toEqual([
      'RECIPE_DRAFT_CREATED:1:návrh kusovníku',
      'RECIPE_DRAFT_UPDATED:1:doplnění kusovníku',
      'RECIPE_ACTIVATED:1:schváleno',
      'RECIPE_DRAFT_CREATED:2:návrh kusovníku',
      'RECIPE_DRAFT_UPDATED:2:menší náplň',
      'RECIPE_ARCHIVED:1:schváleno',
      'RECIPE_ACTIVATED:2:schváleno',
      'RECIPE_ARCHIVED:2:už se nepoužívá',
    ]);
  });

  it('archiving a draft keeps it readable and blocks its activation', async () => {
    const k = await kit();
    const p = await product();
    await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    expect((await archive(p.code, 1)).body).toMatchObject({
      status: 'ARCHIVED',
      activatedAt: null,
    });
    expect((await activate(p.code, 1, null)).body.code).toBe('RECIPE_NOT_DRAFT');
    expect(
      (await as(admin).get(`${api}/products/${p.code}/recipes/1`)).body.components,
    ).toHaveLength(4);
  });

  it('concurrent drafts get consecutive versions; a code is taken only once', async () => {
    const k = await kit();
    const p = await product();
    const drafts = await Promise.all(
      Array.from({ length: 5 }, () =>
        draft(p.code, { crateTypeCode: k.crate.code, components: k.lines }),
      ),
    );
    expect(drafts.map((d) => d.status)).toEqual([201, 201, 201, 201, 201]);
    expect(drafts.map((d) => (d.body as RecipeVersion).version).sort()).toEqual([1, 2, 3, 4, 5]);

    const code = `SOAP-${sfx()}`;
    const products = await Promise.all(
      [1, 2].map(() =>
        as(admin).post(`${api}/products`, {
          requestId: randomUUID(),
          code,
          name: 'Tekuté mýdlo 330 ml',
          categoryCode: 'HAND_SOAP',
          nominalQuantity: '330',
          nominalUnitCode: 'ml',
          reason: 'souběh',
        }),
      ),
    );
    expect(products.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(products.find((r) => r.status === 409)!.body.code).toBe('CODE_TAKEN');
    const pumpCode = `PUMP-${sfx()}`;
    const pumps = await Promise.all(
      [1, 2].map(() => component({ kind: 'PUMP', code: pumpCode }).catch((e: Error) => e)),
    );
    expect(pumps.filter((r) => r instanceof Error)).toHaveLength(1);
    expect(await t.prisma.inventoryItem.count({ where: { code: pumpCode } })).toBe(1);
  });

  it('a product name is corrected and a product archived without losing history', async () => {
    const k = await kit();
    const p = await product();
    const rename = (name: string) =>
      as(admin).post(`${api}/products/${p.code}/rename`, {
        requestId: randomUUID(),
        name,
        reason: 'překlep v názvu',
      });
    const renamed = await rename('Tekuté mýdlo 330 ml (opraveno)');
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({
      code: p.code,
      name: 'Tekuté mýdlo 330 ml (opraveno)',
      status: 'ACTIVE',
      category: p.category,
      nominalQuantity: '330',
    });
    expect((await rename('Tekuté mýdlo 330 ml (opraveno)')).body.code).toBe('NO_CHANGES');
    expect(
      await t.prisma.auditEvent.findFirstOrThrow({
        where: { type: 'PRODUCT_RENAMED', payload: { path: ['product'], equals: p.code } },
      }),
    ).toMatchObject({
      reason: 'překlep v názvu',
      payload: expect.objectContaining({
        before: 'Tekuté mýdlo 330 ml',
        after: 'Tekuté mýdlo 330 ml (opraveno)',
      }),
    });

    // Archiving waits for the active recipe to be archived first (an explicit step).
    await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    expect((await activate(p.code, 1, null)).status).toBe(200);
    await draft(p.code, { basedOnVersion: 1 });
    const archiveProduct = () =>
      as(admin).post(`${api}/products/${p.code}/archive`, {
        requestId: randomUUID(),
        reason: 'produkt se už nevyrábí',
      });
    const blocked = await archiveProduct();
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PRODUCT_HAS_ACTIVE_RECIPE');
    expect((await archive(p.code, 1)).status).toBe(200);
    const archived = await archiveProduct();
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body).toMatchObject({ status: 'ARCHIVED', activeVersion: null });
    expect(archived.body.archivedAt).not.toBeNull();

    // Afterwards: nothing changes, everything stays readable and calculable.
    expect((await rename('Jiný název')).body.code).toBe('PRODUCT_ARCHIVED');
    expect((await archiveProduct()).body.code).toBe('PRODUCT_ARCHIVED');
    expect((await draft(p.code, { basedOnVersion: 1 })).body.code).toBe('PRODUCT_ARCHIVED');
    expect((await activate(p.code, 2, null)).body.code).toBe('PRODUCT_ARCHIVED');
    const edit = await as(admin).put(`${api}/products/${p.code}/recipes/2`, {
      requestId: randomUUID(),
      reason: 'úprava',
      crateTypeCode: null,
      components: [],
    });
    expect(edit.body.code).toBe('PRODUCT_ARCHIVED');
    const old = await as(admin).get(`${api}/products/${p.code}/recipes/1`);
    expect(old.status).toBe(200);
    expect((old.body as RecipeVersion).components).toHaveLength(4);
    expect(
      (await as(admin).get(`${api}/products/${p.code}/recipes/1/requirements?bottles=40`)).status,
    ).toBe(200);
    // The database refuses the same on its own.
    const row = await t.prisma.product.findUniqueOrThrow({ where: { code: p.code } });
    await expect(
      t.prisma.$executeRaw`UPDATE products SET name = 'X' WHERE id = ${row.id}::uuid`,
    ).rejects.toThrow(/archived product never changes/);
    await expect(
      t.prisma
        .$executeRaw`UPDATE products SET status = 'ACTIVE', archived_at = NULL, archived_by = NULL WHERE id = ${row.id}::uuid`,
    ).rejects.toThrow(/archived product never changes/);
  });

  it('two concurrent activations of two versions: exactly one wins', async () => {
    const k = await kit();
    const p = await product();
    await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    const results = await Promise.all([activate(p.code, 1, null), activate(p.code, 2, null)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('ACTIVE_VERSION_CHANGED');
    const product_ = await t.prisma.product.findUniqueOrThrow({ where: { code: p.code } });
    expect(
      await t.prisma.recipeVersion.count({ where: { productId: product_.id, status: 'ACTIVE' } }),
    ).toBe(1);
  });

  // --- validation --------------------------------------------------------------------------------

  it('refuses duplicates, wrong units, invalid quantities and incompatible components', async () => {
    const k = await kit('HAND_SOAP');
    const gel = await kit('SHOWER_GEL');
    const box = await component({ kind: 'PACKAGING', name: 'Krabice' });
    const p = await product('HAND_SOAP');
    const before = await catalogCounts();
    const auditBefore = await t.prisma.auditEvent.count();
    const replace = (i: number, patch: object) =>
      k.lines.map((l, j) => (j === i ? { ...l, ...patch } : l));
    const cases: [object, number, string?][] = [
      [{ components: [...k.lines, k.lines[2]] }, 422, 'DUPLICATE_COMPONENT'],
      [
        { components: [...k.lines, { itemCode: gel.pump.code, quantity: '1', unitCode: 'pcs' }] },
        422,
        'DUPLICATE_COMPONENT_KIND',
      ],
      [{ components: replace(1, { unitCode: 'pcs' }) }, 422, 'UNIT_MISMATCH'],
      [{ components: replace(1, { unitCode: 'g' }) }, 422, 'UNIT_MISMATCH'],
      [{ components: replace(2, { quantity: '1.5' }) }, 422, 'INVALID_QUANTITY'],
      [{ components: replace(1, { quantity: '330.0001' }) }, 400],
      [{ components: replace(0, { quantity: '2' }) }, 422, 'BOTTLE_BODY_QUANTITY'],
      [{ components: replace(1, { quantity: '0' }) }, 400],
      [{ components: replace(1, { quantity: '-330' }) }, 400],
      [
        { components: replace(1, { itemCode: gel.liquid.code }) },
        422,
        'COMPONENT_CATEGORY_MISMATCH',
      ],
      [
        { components: replace(3, { itemCode: gel.label.code }) },
        422,
        'COMPONENT_CATEGORY_MISMATCH',
      ],
      [
        { components: [...k.lines, { itemCode: box.code, quantity: '1', unitCode: 'pcs' }] },
        422,
        'COMPONENT_NOT_ALLOWED',
      ],
      [{ components: replace(2, { itemCode: 'NO-SUCH-ITEM' }) }, 422, 'UNKNOWN_ITEM'],
      [{ crateTypeCode: gel.crate.code }, 422, 'CRATE_TYPE_CATEGORY_MISMATCH'],
      [{ crateTypeCode: 'NO-SUCH-CRATE' }, 422, 'UNKNOWN_CRATE_TYPE'],
      [{ components: replace(1, { quantity: 330 }) }, 400],
      [{ basedOnVersion: 77 }, 422, 'UNKNOWN_BASE_VERSION'],
      [{ basedOnVersion: 1, components: k.lines }, 400],
    ];
    for (const [patch, status, code] of cases) {
      const body =
        'basedOnVersion' in patch
          ? patch
          : { crateTypeCode: k.crate.code, components: k.lines, ...patch };
      const res = await draft(p.code, body);
      expect(res.status, JSON.stringify(patch)).toBe(status);
      if (code) expect(res.body.code, JSON.stringify(patch)).toBe(code);
      expect(JSON.stringify(res.body)).not.toMatch(/AYVO:|prisma|SELECT|INSERT|constraint/i);
    }
    expect((await draft('NO-SUCH-PRODUCT', { crateTypeCode: null, components: [] })).status).toBe(
      404,
    );
    // Zero impact: no version, revision, BOM, request row or audit event from any of them.
    expect(await catalogCounts()).toEqual(before);
    expect(await t.prisma.auditEvent.count()).toBe(auditBefore);
  });

  it('a shared blank label (no category) serves every category; a category label only its own (doc 023 §4a)', async () => {
    const shared = await component({
      kind: 'LABEL_MEDIA',
      name: 'Černá prázdná etiketa',
      lotTracked: false,
      packageCapacity: 300,
    });
    expect([shared.category, shared.packageCapacity]).toEqual([null, 300]);
    for (const category of ['HAND_SOAP', 'SHOWER_GEL']) {
      const k = await kit(category);
      const p = await product(category);
      const lines = k.lines.map((l) =>
        l.itemCode === k.label.code ? { ...l, itemCode: shared.code } : l,
      );
      const res = await draft(p.code, { components: lines, crateTypeCode: k.crate.code });
      expect([category, res.status], JSON.stringify(res.body)).toEqual([category, 201]);
      // The database accepts the activated recipe with the shared label as well.
      const v = (res.body as { version: number }).version;
      await activate(p.code, v, null).expect(200);
    }
    // A label made for one category stays refused in a recipe of another (only the label differs).
    const soap = await kit('HAND_SOAP');
    const gelKit = await kit('SHOWER_GEL');
    const gel = await product('SHOWER_GEL');
    const refused = await draft(gel.code, {
      components: gelKit.lines.map((l) =>
        l.itemCode === gelKit.label.code ? { ...l, itemCode: soap.label.code } : l,
      ),
      crateTypeCode: gelKit.crate.code,
    });
    expect([refused.status, refused.body.code]).toEqual([422, 'COMPONENT_CATEGORY_MISMATCH']);
    // The warehouse sees pieces per roll for the label only — stock stays in pcs.
    const items = (await as(admin).get('/api/admin/inventory/items').expect(200)).body as {
      code: string;
      unit: { code: string };
      piecesPerRoll: number | null;
    }[];
    expect(items.find((i) => i.code === shared.code)).toMatchObject({
      unit: { code: 'pcs' },
      piecesPerRoll: 300,
    });
    expect(items.find((i) => i.code === soap.label.code)!.piecesPerRoll).toBeNull();
  });

  it('an item archived after drafting blocks the activation', async () => {
    const k = await kit();
    const p = await product();
    await draft(p.code, { crateTypeCode: k.crate.code, components: k.lines });
    // There is no archive operation for items yet; the column exists (doc 018).
    await t.prisma
      .$executeRaw`UPDATE inventory_items SET archived_at = now() WHERE code = ${k.pump.code}`;
    const res = await activate(p.code, 1, null);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ITEM_ARCHIVED');
    expect(
      (await t.prisma.recipeVersion.findFirstOrThrow({ where: { product: { code: p.code } } }))
        .status,
    ).toBe('DRAFT');
  });

  // --- material requirements -----------------------------------------------------------------------

  it('calculates exactly for 1, 40, 41 and 1 000 000 bottles; crates are rounded up', async () => {
    const { k, p } = await activeRecipe();
    const calc = async (bottles: number | string) => {
      const res = await as(admin).get(
        `${api}/products/${p.code}/recipes/1/requirements?bottles=${bottles}`,
      );
      return res;
    };
    const totals = (r: MaterialRequirements) =>
      Object.fromEntries(r.components.map((c) => [c.kind, `${c.totalQuantity} ${c.unit.code}`]));

    const forty = (await calc(40)).body as MaterialRequirements;
    expect(totals(forty)).toEqual({
      NEW_BOTTLE: '40 pcs',
      LABEL_MEDIA: '40 pcs',
      BULK_LIQUID: '13200 ml',
      PUMP: '40 pcs',
    });
    expect(forty.components.find((c) => c.kind === 'BULK_LIQUID')!.itemCode).toBe(k.liquid.code);
    expect(forty.components.find((c) => c.kind === 'LABEL_MEDIA')!.itemCode).toBe(k.label.code);
    expect(forty.crates).toEqual({
      crateType: { code: k.crate.code, name: 'Vratná výrobní bedna', capacity: 40 },
      count: 1,
      full: 1,
      partialCrateBottles: 0,
    });
    expect(forty).toMatchObject({ bottles: 40, version: 1, status: 'ACTIVE' });

    const one = (await calc(1)).body as MaterialRequirements;
    expect(totals(one)).toEqual({
      NEW_BOTTLE: '1 pcs',
      LABEL_MEDIA: '1 pcs',
      BULK_LIQUID: '330 ml',
      PUMP: '1 pcs',
    });
    expect(one.crates).toMatchObject({ count: 1, full: 0, partialCrateBottles: 1 });

    const fortyOne = (await calc(41)).body as MaterialRequirements;
    expect(totals(fortyOne).BULK_LIQUID).toBe('13530 ml');
    expect(fortyOne.crates).toMatchObject({ count: 2, full: 1, partialCrateBottles: 1 });

    const million = (await calc(1_000_000)).body as MaterialRequirements;
    expect(totals(million)).toEqual({
      NEW_BOTTLE: '1000000 pcs',
      LABEL_MEDIA: '1000000 pcs',
      BULK_LIQUID: '330000000 ml',
      PUMP: '1000000 pcs',
    });
    expect(million.crates).toMatchObject({ count: 25_000, full: 25_000, partialCrateBottles: 0 });

    for (const bad of [0, -1, 1.5, 'abc', 1_000_001])
      expect((await calc(bad)).status, String(bad)).toBe(400);
    expect((await as(admin).get(`${api}/products/${p.code}/recipes/1/requirements`)).status).toBe(
      400,
    );
    expect((await calc(40)).status).toBe(200);
    expect(
      (await as(admin).get(`${api}/products/${p.code}/recipes/9/requirements?bottles=1`)).status,
    ).toBe(404);
  });

  // --- authorization and reasons ------------------------------------------------------------------

  it('reading needs catalog:read; changes need catalog:product_manage or catalog:recipe_approve', async () => {
    const { k, p } = await activeRecipe();
    const operator = await createUser(['PRODUCTION_OPERATOR']);
    const warehouse = await createUser(['WAREHOUSE_OPERATOR']);
    const supervisor = await createUser(['PRODUCTION_SUPERVISOR']);

    expect((await http().get(`${api}/products`)).status).toBe(401);
    expect((await http().post(`${api}/products`).send({})).status).toBe(401);
    expect((await as(warehouse).get(`${api}/products`)).status).toBe(403);
    expect((await as(warehouse).get(`${api}/units`)).status).toBe(403);
    expect(
      (await as(warehouse).get(`${api}/products/${p.code}/recipes/1/requirements?bottles=40`))
        .status,
    ).toBe(403);

    // Operational roles read the company-wide catalogue (no site data in it).
    for (const reader of [operator, supervisor]) {
      expect((await as(reader).get(`${api}/products/${p.code}`)).status).toBe(200);
      expect((await as(reader).get(`${api}/components`)).status).toBe(200);
      expect((await as(reader).get(`${api}/units`)).status).toBe(200);
      expect(
        (await as(reader).get(`${api}/products/${p.code}/recipes/1/requirements?bottles=40`))
          .status,
      ).toBe(200);
    }
    // …but only ADMIN and the production supervisor change it (doc 020 §12); an operator cannot.
    const before = await catalogCounts();
    expect(
      (await as(operator).post(`${api}/components`, { requestId: randomUUID(), kind: 'PUMP' }))
        .status,
    ).toBe(403);
    expect((await as(operator).post(`${api}/products`, {})).status).toBe(403);
    expect((await as(operator).post(`${api}/crate-types`, {})).status).toBe(403);
    expect((await as(operator).post(`${api}/products/${p.code}/archive`, {})).status).toBe(403);
    expect((await draft(p.code, { basedOnVersion: 1 }, operator)).status).toBe(403);
    expect((await activate(p.code, 1, null, operator)).status).toBe(403);
    expect(await catalogCounts()).toEqual(before);
    const supervised = await draft(p.code, { basedOnVersion: 1 }, supervisor);
    expect(supervised.status, JSON.stringify(supervised.body)).toBe(201);
    const v2version = (supervised.body as RecipeVersion).version;
    expect((await activate(p.code, v2version, 1, supervisor)).status).toBe(200);

    // A custom role with catalog:product_manage only drafts; activation needs catalog:recipe_approve.
    const role = await as(admin).post('/api/admin/identity/roles', {
      code: `CATALOG_EDITOR_${sfx()}`,
      name: 'Editor katalogu',
      description: 'Zakládá návrhy kusovníků',
      permissions: ['catalog:read', 'catalog:product_manage'],
      reason: 'test role',
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const editor = await createUser([role.body.code as string]);
    const v3 = await draft(p.code, { basedOnVersion: 1 }, editor);
    expect(v3.status, JSON.stringify(v3.body)).toBe(201);
    const v3version = (v3.body as RecipeVersion).version;
    expect((await activate(p.code, v3version, v2version, editor)).status).toBe(403);
    expect((await activate(p.code, v3version, v2version)).status).toBe(200);

    // The reason is mandatory everywhere.
    const noReason = [
      as(admin).post(`${api}/components`, {
        requestId: randomUUID(),
        code: `R-${sfx()}`,
        name: 'X',
        kind: 'PUMP',
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: null,
        packageCapacity: null,
      }),
      as(admin).post(`${api}/crate-types`, {
        requestId: randomUUID(),
        code: `C-${sfx()}`,
        name: 'X',
        capacity: 40,
        categoryCodes: ['HAND_SOAP'],
        reason: '',
      }),
      draft(p.code, { basedOnVersion: 1, reason: '  ' }),
      as(admin).post(`${api}/products/${p.code}/recipes/3/activate`, {
        requestId: randomUUID(),
        expectedActiveVersion: 2,
      }),
      as(admin).post(`${api}/products/${p.code}/recipes/2/archive`, { requestId: randomUUID() }),
      as(admin).post(`${api}/products/${p.code}/rename`, { requestId: randomUUID(), name: 'Nový' }),
      as(admin).post(`${api}/products/${p.code}/archive`, { requestId: randomUUID() }),
      as(admin).put(`${api}/products/${p.code}/recipes/1`, {
        requestId: randomUUID(),
        crateTypeCode: k.crate.code,
        components: k.lines,
      }),
    ];
    for (const res of await Promise.all(noReason)) expect(res.status).toBe(400);
  });

  // --- idempotency ------------------------------------------------------------------------------

  it('a repeated request id replays the stored result; another payload conflicts', async () => {
    const k = await kit();
    const p = await product();
    const body = {
      requestId: randomUUID(),
      reason: 'návrh kusovníku',
      crateTypeCode: k.crate.code,
      components: k.lines,
    };
    const first = await as(admin).post(`${api}/products/${p.code}/recipes`, body);
    expect(first.status).toBe(201);
    const counts = await catalogCounts();
    const replay = await as(admin).post(`${api}/products/${p.code}/recipes`, body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await catalogCounts()).toEqual(counts);
    const conflict = await as(admin).post(`${api}/products/${p.code}/recipes`, {
      ...body,
      reason: 'jiný důvod',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    // Bound to the author: another user with the same permission gets a conflict, not the result.
    const other = await createUser(['PRODUCTION_SUPERVISOR']);
    const foreign = await as(other).post(`${api}/products/${p.code}/recipes`, body);
    expect(foreign.status).toBe(409);
    expect(foreign.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await catalogCounts()).toEqual(counts);

    // Concurrent duplicates of one activation: one effect, the same answer twice.
    const act = {
      requestId: randomUUID(),
      reason: 'schváleno',
      expectedActiveVersion: null,
    };
    const [a, b] = await Promise.all([
      as(admin).post(`${api}/products/${p.code}/recipes/1/activate`, act),
      as(admin).post(`${api}/products/${p.code}/recipes/1/activate`, act),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(
      await t.prisma.auditEvent.count({
        where: {
          type: 'RECIPE_ACTIVATED',
          payload: { path: ['requestId'], equals: act.requestId },
        },
      }),
    ).toBe(1);

    // A refused request stores nothing: the same id succeeds once the cause is fixed.
    const p2 = await product();
    const retry = {
      requestId: randomUUID(),
      reason: 'návrh',
      crateTypeCode: k.crate.code,
      components: k.lines,
    };
    expect((await as(admin).post(`${api}/products/NO-SUCH/recipes`, retry)).status).toBe(404);
    expect((await as(admin).post(`${api}/products/${p2.code}/recipes`, retry)).status).toBe(201);

    // Components and crate types replay too (no second item, no second type).
    const comp = {
      requestId: randomUUID(),
      code: `PUMP-${sfx()}`,
      name: 'Pumpička',
      kind: 'PUMP',
      unitCode: 'pcs',
      lotTracked: true,
      categoryCode: null,
      packageCapacity: null,
      reason: 'katalog',
    };
    const [c1, c2] = await Promise.all([
      as(admin).post(`${api}/components`, comp),
      as(admin).post(`${api}/components`, comp),
    ]);
    expect([c1.status, c2.status]).toEqual([201, 201]);
    expect(await t.prisma.inventoryItem.count({ where: { code: comp.code } })).toBe(1);
  });

  // --- the database on its own ---------------------------------------------------------------------

  describe('database invariants (without the application)', () => {
    const rejects = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

    it('reference data, components, crate types and products are immutable', async () => {
      const k = await kit();
      const p = await product();
      await rejects(t.prisma.$executeRaw`UPDATE product_categories SET name = 'X'`, /immutable/);
      await rejects(
        t.prisma.$executeRaw`DELETE FROM product_categories WHERE code = 'HAND_SOAP'`,
        /immutable/,
      );
      await rejects(
        t.prisma.$executeRaw`UPDATE catalog_components SET category_code = 'SHOWER_GEL'
          WHERE item_id = (SELECT id FROM inventory_items WHERE code = ${k.liquid.code})`,
        /immutable/,
      );
      await rejects(
        t.prisma.$executeRaw`UPDATE crate_types SET capacity = 41 WHERE code = ${k.crate.code}`,
        /immutable/,
      );
      await rejects(t.prisma.$executeRaw`DELETE FROM crate_type_categories`, /immutable/);
      await rejects(
        t.prisma
          .$executeRaw`UPDATE products SET category_code = 'SHOWER_GEL' WHERE code = ${p.code}`,
        /immutable/,
      );
      await rejects(
        t.prisma.$executeRaw`DELETE FROM products WHERE code = ${p.code}`,
        /never deleted/,
      );
      // Even the privileged account (the running core has no TRUNCATE right at all).
      await withPrivileged((db) =>
        rejects(db.$executeRaw`TRUNCATE recipe_versions CASCADE`, /immutable|not allowed/),
      );
    });

    it('a liquid names its category; a label may not (shared stock); only packaging and labels have a capacity', async () => {
      const liquid = await t.prisma.inventoryItem.create({
        data: {
          code: `RAW-LIQ-${sfx()}`,
          name: 'raw',
          kind: 'BULK_LIQUID',
          baseUnit: { connect: { code: 'ml' } },
          lotTracking: 'NONE',
        },
      });
      const pump = await t.prisma.inventoryItem.create({
        data: {
          code: `RAW-PUMP-${sfx()}`,
          name: 'raw',
          kind: 'PUMP',
          baseUnit: { connect: { code: 'pcs' } },
          lotTracking: 'NONE',
        },
      });
      const op = randomUUID();
      await t.prisma.operationRequest.create({
        data: { requestId: op, kind: 'CATALOG_COMPONENT_CREATE', payloadSha256: '0'.repeat(64) },
      });
      await rejects(
        t.prisma.catalogComponent.create({
          data: { itemId: liquid.id, createdBy: adminId, operationRequestId: op },
        }),
        /names its product category/,
      );
      await rejects(
        t.prisma.catalogComponent.create({
          data: {
            itemId: pump.id,
            packageCapacity: 40,
            createdBy: adminId,
            operationRequestId: op,
          },
        }),
        /only packaging and labels/,
      );
      // The shared blank label: no category, pieces per roll as an entry aid.
      const label = await t.prisma.inventoryItem.create({
        data: {
          code: `RAW-LABEL-${sfx()}`,
          name: 'raw',
          kind: 'LABEL_MEDIA',
          baseUnit: { connect: { code: 'pcs' } },
          lotTracking: 'NONE',
        },
      });
      await t.prisma.catalogComponent.create({
        data: {
          itemId: label.id,
          packageCapacity: 300,
          createdBy: adminId,
          operationRequestId: op,
        },
      });
      await rejects(
        t.prisma.crateType.create({
          data: {
            code: `RAW-${sfx()}`,
            name: 'x',
            capacity: 40,
            createdBy: adminId,
            operationRequestId: op,
          },
        }),
        /at least one product category/,
      );
      await rejects(
        t.prisma.crateType.create({
          data: {
            code: `RAW-${sfx()}`,
            name: 'x',
            capacity: 0,
            createdBy: adminId,
            operationRequestId: op,
            categories: { create: [{ categoryCode: 'HAND_SOAP' }] },
          },
        }),
        /crate_types_capacity_check/,
      );
    });

    it('recipe versions: one active per product, forward-only, complete, sealed', async () => {
      const { k, p } = await activeRecipe();
      const productRow = await t.prisma.product.findUniqueOrThrow({ where: { code: p.code } });
      const v1 = await t.prisma.recipeVersion.findFirstOrThrow({
        where: { productId: productRow.id, version: 1 },
      });
      const v2res = await draft(p.code, { basedOnVersion: 1 });
      expect(v2res.status).toBe(201);
      const v2 = await t.prisma.recipeVersion.findFirstOrThrow({
        where: { productId: productRow.id, version: 2 },
      });

      // A second ACTIVE version of the same product.
      await rejects(
        t.prisma.recipeVersion.update({
          where: { id: v2.id },
          data: { status: 'ACTIVE', activatedAt: new Date(), activatedBy: adminId },
        }),
        /recipe_versions_one_active|Unique constraint/,
      );
      // Backwards, or any edit of an active version.
      await rejects(
        t.prisma
          .$executeRaw`UPDATE recipe_versions SET status = 'DRAFT', activated_at = NULL, activated_by = NULL WHERE id = ${v1.id}::uuid`,
        /forward only/,
      );
      await rejects(
        t.prisma
          .$executeRaw`UPDATE recipe_versions SET activated_at = now() - interval '1 day' WHERE id = ${v1.id}::uuid`,
        /forward only/,
      );
      await rejects(
        t.prisma.$executeRaw`UPDATE recipe_versions SET status = 'ARCHIVED', archived_at = now(),
          archived_by = ${adminId}::uuid, activated_at = now(), activated_by = ${adminId}::uuid
          WHERE id = ${v2.id}::uuid`,
        /only activation records an activation/,
      );
      await rejects(
        t.prisma.$executeRaw`DELETE FROM recipe_versions WHERE id = ${v1.id}::uuid`,
        /never deleted/,
      );
      // No new revision for an active version, no line in a linked BOM, no revision rewrite.
      const op = randomUUID();
      await t.prisma.operationRequest.create({
        data: { requestId: op, kind: 'RECIPE_DRAFT_UPDATE', payloadSha256: '0'.repeat(64) },
      });
      // (Raw SQL: Prisma's model API renames restrict/unique violations and hides the message.)
      await rejects(
        t.prisma.$executeRaw`INSERT INTO recipe_revisions
          (recipe_version_id, revision, category_code, created_by, operation_request_id)
          VALUES (${v1.id}::uuid, 3, 'HAND_SOAP', ${adminId}::uuid, ${op}::uuid)`,
        /only a draft/,
      );
      const linked = await t.prisma.recipeRevisionBom.findFirstOrThrow({
        where: { recipeVersionId: v1.id, stage: 'FILL' },
      });
      const pump = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: k.pump.code } });
      await rejects(
        t.prisma
          .$executeRaw`INSERT INTO bom_lines (bom_version_id, line_no, item_id, unit_id, quantity)
          VALUES (${linked.bomVersionId}::uuid, 9, ${pump.id}::uuid, ${pump.baseUnitId}::uuid, 1)`,
        /sealed/,
      );
      await rejects(
        t.prisma.$executeRaw`UPDATE recipe_revisions SET crate_type_id = NULL`,
        /immutable/,
      );
      await rejects(t.prisma.$executeRaw`DELETE FROM recipe_revision_boms`, /immutable/);
      await rejects(
        t.prisma
          .$executeRaw`DELETE FROM bom_lines WHERE bom_version_id = ${linked.bomVersionId}::uuid`,
        /immutable/,
      );
      // Revisions of a draft are consecutive.
      await rejects(
        t.prisma.recipeRevision.create({
          data: {
            recipeVersionId: v2.id,
            revision: 5,
            categoryCode: 'HAND_SOAP',
            createdBy: adminId,
            operationRequestId: op,
          },
        }),
        /consecutive/,
      );
      // A version never starts active, and never exists without its first revision.
      await rejects(
        t.prisma.recipeVersion.create({
          data: {
            productId: productRow.id,
            categoryCode: 'HAND_SOAP',
            version: 50,
            status: 'ACTIVE',
            activatedAt: new Date(),
            activatedBy: adminId,
            createdBy: adminId,
            operationRequestId: op,
          },
        }),
        /starts as a draft/,
      );
      await rejects(
        t.prisma.recipeVersion.create({
          data: {
            productId: productRow.id,
            categoryCode: 'HAND_SOAP',
            version: 51,
            createdBy: adminId,
            operationRequestId: op,
          },
        }),
        /first revision/,
      );
      // The category copy must be the product's own.
      await rejects(
        t.prisma.$transaction(async (tx) => {
          const v = await tx.recipeVersion.create({
            data: {
              productId: productRow.id,
              categoryCode: 'SHOWER_GEL',
              version: 52,
              createdBy: adminId,
              operationRequestId: op,
            },
          });
          await tx.recipeRevision.create({
            data: {
              recipeVersionId: v.id,
              revision: 1,
              categoryCode: 'SHOWER_GEL',
              createdBy: adminId,
              operationRequestId: op,
            },
          });
        }),
        /Foreign key|foreign key/,
      );
    });

    it('recipe BOM lines: stage, unit, bottle quantity, category and one line per kind', async () => {
      const k = await kit('HAND_SOAP');
      const gel = await kit('SHOWER_GEL');
      const p = await product('HAND_SOAP');
      const productRow = await t.prisma.product.findUniqueOrThrow({ where: { code: p.code } });
      const items = Object.fromEntries(
        (
          await t.prisma.inventoryItem.findMany({
            where: { code: { in: [k.bottle.code, k.liquid.code, k.pump.code, gel.liquid.code] } },
          })
        ).map((i) => [i.code, i]),
      );
      const op = randomUUID();
      await t.prisma.operationRequest.create({
        data: { requestId: op, kind: 'RECIPE_DRAFT_CREATE', payloadSha256: '0'.repeat(64) },
      });
      /** One transaction: a draft version with one BOM of the given lines. */
      const attempt = (
        stage: 'LABEL_APPLICATION' | 'FILL',
        lines: { code: string; quantity: number }[],
        bomCode?: (version: number) => string,
      ) =>
        t.prisma.$transaction(async (tx) => {
          const n = 100 + Math.floor(Math.random() * 9000);
          const v = await tx.recipeVersion.create({
            data: {
              productId: productRow.id,
              categoryCode: 'HAND_SOAP',
              version: n,
              createdBy: adminId,
              operationRequestId: op,
            },
          });
          await tx.recipeRevision.create({
            data: {
              recipeVersionId: v.id,
              revision: 1,
              categoryCode: 'HAND_SOAP',
              createdBy: adminId,
              operationRequestId: op,
            },
          });
          const bom = await tx.bomVersion.create({
            data: {
              code: bomCode ? bomCode(n) : `R-${p.code}-V${n}-${stage === 'FILL' ? 'FL' : 'LA'}`,
              version: 1,
              stage,
              validFrom: new Date(),
              lines: {
                create: lines.map((l, i) => ({
                  lineNo: i + 1,
                  itemId: items[l.code]!.id,
                  unitId: items[l.code]!.baseUnitId,
                  quantity: l.quantity,
                })),
              },
            },
          });
          // Raw SQL keeps the database's own message (see above).
          await tx.$executeRaw`INSERT INTO recipe_revision_boms
            (recipe_version_id, revision, stage, bom_version_id)
            VALUES (${v.id}::uuid, 1, ${stage}::"ConsumptionStage", ${bom.id}::uuid)`;
        });
      await rejects(
        attempt('FILL', [{ code: k.bottle.code, quantity: 1 }]),
        /does not belong to stage/,
      );
      await rejects(
        attempt('LABEL_APPLICATION', [{ code: k.pump.code, quantity: 1 }]),
        /does not belong to stage/,
      );
      await rejects(
        attempt('LABEL_APPLICATION', [{ code: k.bottle.code, quantity: 2 }]),
        /exactly one bottle body/,
      );
      await rejects(
        attempt('FILL', [{ code: gel.liquid.code, quantity: 330 }]),
        /not made for product category/,
      );
      await rejects(
        attempt('FILL', [
          { code: k.liquid.code, quantity: 330 },
          { code: k.liquid.code, quantity: 10 },
        ]),
        /one line per component kind/,
      );
      // Only the recipe's own BOM: a foreign code, or the global stage rule itself, is refused.
      await rejects(
        attempt('FILL', [{ code: k.liquid.code, quantity: 330 }], () => `RAW-${sfx()}`),
        /links only its own BOM/,
      );
      const legacy = await t.prisma.bomVersion.findUniqueOrThrow({
        where: { code_version: { code: 'LABEL_APPLICATION', version: 1 } },
      });
      await rejects(
        t.prisma.$transaction(async (tx) => {
          const v = await tx.recipeVersion.create({
            data: {
              productId: productRow.id,
              categoryCode: 'HAND_SOAP',
              version: 9000,
              createdBy: adminId,
              operationRequestId: op,
            },
          });
          await tx.recipeRevision.create({
            data: {
              recipeVersionId: v.id,
              revision: 1,
              categoryCode: 'HAND_SOAP',
              createdBy: adminId,
              operationRequestId: op,
            },
          });
          await tx.$executeRaw`INSERT INTO recipe_revision_boms
            (recipe_version_id, revision, stage, bom_version_id)
            VALUES (${v.id}::uuid, 1, 'LABEL_APPLICATION', ${legacy.id}::uuid)`;
        }),
        /links only its own BOM/,
      );
      // The bottle body is lot-tracked (consumed from the lot the operator selects).
      const loose = await t.prisma.inventoryItem.create({
        data: {
          code: `RAW-BOTTLE-${sfx()}`,
          name: 'raw',
          kind: 'NEW_BOTTLE',
          baseUnit: { connect: { code: 'pcs' } },
          lotTracking: 'NONE',
        },
      });
      items[loose.code] = loose;
      await rejects(
        attempt('LABEL_APPLICATION', [{ code: loose.code, quantity: 1 }]),
        /bottle body of a recipe is lot-tracked/,
      );
      await rejects(
        t.prisma.catalogComponent.create({
          data: { itemId: loose.id, createdBy: adminId, operationRequestId: op },
        }),
        /bottle body component is lot-tracked/,
      );
      // Nothing of the refused attempts remains.
      expect(await t.prisma.recipeVersion.count({ where: { productId: productRow.id } })).toBe(0);
      // Activation in the database alone: an incomplete version cannot become active.
      const res = await draft(p.code, { crateTypeCode: null, components: k.lines });
      expect(res.status).toBe(201);
      // The API refuses the same loose bottle body.
      const looseRes = await draft(p.code, {
        crateTypeCode: null,
        components: [{ itemCode: loose.code, quantity: '1', unitCode: 'pcs' }],
      });
      expect(looseRes.body.code).toBe('LOT_TRACKING_REQUIRED');
      const v = await t.prisma.recipeVersion.findFirstOrThrow({
        where: { productId: productRow.id },
      });
      await rejects(
        t.prisma.recipeVersion.update({
          where: { id: v.id },
          data: { status: 'ACTIVE', activatedAt: new Date(), activatedBy: adminId },
        }),
        /names its crate type/,
      );
    });

    it('sealing a recipe BOM and adding a line to it are serialised (two connections)', async () => {
      const k = await kit();
      const p = await product();
      expect((await draft(p.code, { crateTypeCode: null, components: [k.lines[1]!] })).status).toBe(
        201,
      );
      const productRow = await t.prisma.product.findUniqueOrThrow({ where: { code: p.code } });
      const v = await t.prisma.recipeVersion.findFirstOrThrow({
        where: { productId: productRow.id },
      });
      const liquid = await t.prisma.inventoryItem.findUniqueOrThrow({
        where: { code: k.liquid.code },
      });
      const pump = await t.prisma.inventoryItem.findUniqueOrThrow({ where: { code: k.pump.code } });
      const op = randomUUID();
      await t.prisma.operationRequest.create({
        data: { requestId: op, kind: 'RECIPE_DRAFT_UPDATE', payloadSha256: '0'.repeat(64) },
      });
      /** A committed, still unlinked FILL BOM of the next revision (the race's subject). */
      async function unlinkedBom(revision: number) {
        await t.prisma.recipeRevision.create({
          data: {
            recipeVersionId: v.id,
            revision,
            categoryCode: 'HAND_SOAP',
            createdBy: adminId,
            operationRequestId: op,
          },
        });
        return t.prisma.bomVersion.create({
          data: {
            code: `R-${p.code}-V1-FL`,
            version: revision,
            stage: 'FILL',
            validFrom: new Date(),
            lines: {
              create: [{ lineNo: 1, itemId: liquid.id, unitId: liquid.baseUnitId, quantity: 330 }],
            },
          },
        });
      }
      const deferred = () => {
        let release!: () => void;
        const promise = new Promise<void>((r) => (release = r));
        return { promise, release };
      };
      const settled = async (p: Promise<unknown>, ms = 400) =>
        Promise.race([
          p.then(
            () => true,
            () => true,
          ),
          new Promise((r) => setTimeout(() => r(false), ms)),
        ]);
      const addPump = (bomId: string) =>
        t.prisma
          .$executeRaw`INSERT INTO bom_lines (bom_version_id, line_no, item_id, unit_id, quantity)
          VALUES (${bomId}::uuid, 2, ${pump.id}::uuid, ${pump.baseUnitId}::uuid, 1)`;
      const link = (tx: Prisma.TransactionClient, revision: number, bomId: string) =>
        tx.$executeRaw`INSERT INTO recipe_revision_boms (recipe_version_id, revision, stage, bom_version_id)
          VALUES (${v.id}::uuid, ${revision}, 'FILL', ${bomId}::uuid)`;

      // 1. The link holds its lock first: the concurrent line waits, then sees the seal.
      const bom2 = await unlinkedBom(2);
      const linked = deferred();
      const commit = deferred();
      const sealing = t.prisma.$transaction(
        async (tx) => {
          await link(tx, 2, bom2.id);
          linked.release();
          await commit.promise;
        },
        { timeout: 20_000 },
      );
      await linked.promise;
      const late = addPump(bom2.id);
      expect(await settled(late)).toBe(false); // blocked by the seal's lock
      commit.release();
      await sealing;
      await expect(late).rejects.toThrow(/sealed/);
      expect(await t.prisma.bomLine.count({ where: { bomVersionId: bom2.id } })).toBe(1);

      // 2. The line holds its lock first: the link waits and then validates it too.
      const bom3 = await unlinkedBom(3);
      const added = deferred();
      const commitLine = deferred();
      const adding = t.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO bom_lines (bom_version_id, line_no, item_id, unit_id, quantity)
            VALUES (${bom3.id}::uuid, 2, ${pump.id}::uuid, ${pump.baseUnitId}::uuid, 1)`;
          added.release();
          await commitLine.promise;
        },
        { timeout: 20_000 },
      );
      await added.promise;
      const sealing3 = t.prisma.$transaction((tx) => link(tx, 3, bom3.id), { timeout: 20_000 });
      expect(await settled(sealing3)).toBe(false); // waits for the line's transaction
      commitLine.release();
      await adding;
      await sealing3;
      // Sealed with both lines, each validated; nothing can be added any more.
      expect(await t.prisma.bomLine.count({ where: { bomVersionId: bom3.id } })).toBe(2);
      await expect(addPump(bom3.id)).rejects.toThrow(/sealed/);
    });

    it('the global label-application rule is never replaced by a recipe BOM', async () => {
      await activeRecipe();
      const bom = await t.app.get(InventoryService).activeBom('LABEL_APPLICATION');
      expect(bom.code).toBe('LABEL_APPLICATION');
      expect(bom.version).toBe(1);
    });
  });

  // --- rollback base: values of a newer version (#85 consumables) ------------------------------

  it('rollback base: a CONSUMABLE item (#85 enum values) is read, but never created here or used in a recipe', async () => {
    const before = await catalogCounts();
    // Creating one is refused by this version's request contract.
    const created = await as(admin).post(`${api}/components`, {
      requestId: randomUUID(),
      code: `CONSUM-${sfx()}`,
      name: 'Páska do tiskárny',
      kind: 'CONSUMABLE',
      unitCode: 'pcs',
      lotTracked: false,
      categoryCode: null,
      packageCapacity: null,
      reason: 'nesmí vzniknout',
    });
    expect(created.status).toBe(400);
    expect(await catalogCounts()).toEqual(before);
    // A row a newer version wrote (the enum value exists in this database).
    const pcs = await t.prisma.inventoryUnit.findUniqueOrThrow({ where: { code: 'pcs' } });
    const code = `RIBBON-${sfx()}`;
    await withPrivileged((db) =>
      db.inventoryItem.create({
        data: {
          code,
          name: 'Páska (novější verze)',
          kind: 'CONSUMABLE',
          baseUnitId: pcs.id,
          lotTracking: 'NONE',
        },
      }),
    );
    // Read: the inventory lists it with its kind and this version's contract accepts it.
    const items = await as(admin).get('/api/admin/inventory/items');
    expect(items.status).toBe(200);
    const item = (items.body as { code: string; kind: string }[]).find((i) => i.code === code);
    expect(item?.kind).toBe('CONSUMABLE');
    expect(z.array(inventoryItemSchema).safeParse(items.body).success).toBe(true);
    // Not offered as a catalogue component, refused in a recipe.
    const components = await as(admin).get(`${api}/components`);
    expect((components.body as CatalogComponent[]).map((c) => c.code)).not.toContain(code);
    const k = await kit();
    const p = await product();
    const res = await draft(p.code, {
      crateTypeCode: k.crate.code,
      components: [...k.lines, { itemCode: code, quantity: '1', unitCode: 'pcs' }],
    });
    expect([res.status, res.body.code]).toEqual([422, 'COMPONENT_NOT_ALLOWED']);
  });
});
