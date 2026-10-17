import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, ProductionReadiness, ReadinessItem, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { printedBottles, receiveBottles, receiveItem } from './support/warehouse-fixtures.js';

/**
 * "Připravit výrobu" (doc 027 §4): the read-only readiness of one product at the active site.
 * Labelling and filling are judged separately (labelling never waits for liquid or pumps);
 * labels are "ready to print" (generated PDF), never claimed as physically printed; every item
 * needs its own existing permission and is UNAVAILABLE without it (no count, never 0 or OK);
 * nothing is written. Synthetic data only.
 */
describe.skipIf(!hasDatabase)('production readiness (doc 027)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let kit: LabelingKit;
  const get = async (query: Record<string, string> = {}) =>
    (
      await request(su.app.getHttpServer())
        .get('/api/admin/production/readiness')
        .query({ product: kit.productCode, ...query })
        .expect(200)
    ).body as ProductionReadiness;
  const of = (r: ProductionReadiness, key: string): ReadinessItem =>
    [...r.setup, ...r.labeling, ...r.filling].find((i) => i.key === key)!;
  const sfx = () => randomUUID().slice(0, 6).toUpperCase();
  const as = (cookie: string) => ({
    get: (path: string) => request(ra.app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(ra.app.getHttpServer()).post(path).set('Cookie', cookie).send(body),
  });

  beforeAll(async () => {
    su = await createTestApp();
    ra = await createTestApp({}, {}, { auth: 'real' });
    kit = await labelingKit(su, { capacity: 2, labelStock: 0 });
    const user = await prepareInvitedUser(ra, {
      email: `ready-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Ready Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
  });
  const createUser = async (roles: string[], siteId = INITIAL_SITE_ID) => {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `ready-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Uživatel ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds: [siteId],
      warehouseCodes: [],
      reason: 'readiness access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cookie = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await as(cookie).post('/api/auth/active-site', { siteId }).expect(200);
    return cookie;
  };
  /** A custom role with workstations and the catalogue only (no stock, crates, bottles, sites). */
  const stationRole = async () => {
    const code = `STATION_ADMIN_${sfx()}`;
    const role = await as(admin).post('/api/admin/identity/roles', {
      code,
      name: 'Správce pracovišť',
      description: 'Pracoviště a katalog bez skladu',
      permissions: ['production:workstations_manage', 'catalog:read'],
      reason: 'readiness test role',
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    return code;
  };

  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
    await su?.close();
  });

  it('labelling and filling separately; PDF-ready labels; real crate states; nothing written', async () => {
    const movements = await su.prisma.inventoryMovement.count();
    let r = await get();
    expect(r.product?.code).toBe(kit.productCode);
    expect(of(r, 'setup.recipe')).toMatchObject({ state: 'OK' });
    expect(of(r, 'setup.design')).toMatchObject({ state: 'MISSING', count: 0 });
    expect(of(r, 'labeling.labels')).toMatchObject({ state: 'MISSING', count: 0 });
    expect(of(r, 'labeling.crate')).toMatchObject({ state: 'MISSING', count: 0 });
    expect(of(r, 'labeling.labelStock')).toMatchObject({ state: 'MISSING', count: 0 });
    // No crate waits yet: filling materials are the active recipe's, marked as the plan.
    expect(of(r, 'filling.liquid')).toMatchObject({ recipe: { version: 1, waitingCrates: null } });
    expect(of(r, 'setup.warehouse')).toMatchObject({ state: 'OK' });
    expect(r.crates).toEqual({ openAssembly: 0, readyToFill: 0, filling: 0, filled: 0 });
    expect(await su.prisma.inventoryMovement.count()).toBe(movements); // read-only

    // Set up labelling only: an approved design, labels with a generated PDF, a crate, stock.
    const bottles = await printedBottles(su, 3);
    const row = await su.prisma.bottle.findUniqueOrThrow({
      where: { id: bottles[0]!.id },
      include: { creationBatch: true },
    });
    const versionId = row.creationBatch.labelTemplateVersionId;
    await approveDesign(su, kit.productCode, versionId);
    const crateUrl = await registerCrate(su, kit.crateTypeCode);
    await receiveItem(su, kit.labelItemId, 10);
    const lot = (await receiveBottles(su, 10)).lines[0]!.lot!.id;
    r = await get();
    expect(of(r, 'setup.design')).toMatchObject({ state: 'OK', count: 1 });
    expect(of(r, 'labeling.labels')).toMatchObject({ state: 'OK', count: 3 });
    // The next step keeps the context (issue #11 UI-21): this product's usable approved design,
    // the stock items of its recipe, the station mode and category.
    const design = await su.prisma.labelTemplateVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: { template: true },
    });
    expect(of(r, 'labeling.labels').target?.designs).toEqual([
      { versionId, label: `${design.template.name} v${design.versionNumber}` },
    ]);
    const code = async (id: string) =>
      (await su.prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).code;
    expect(of(r, 'labeling.labelStock').target?.item?.code).toBe(await code(kit.labelItemId));
    expect(of(r, 'labeling.bottles').target?.item?.code).toBe('NEW_BOTTLE');
    expect(of(r, 'filling.liquid').target?.item?.code).toBe(await code(kit.liquidItemId));
    expect(of(r, 'filling.station').target?.station).toEqual({
      mode: 'FILLING',
      categoryCode: 'HAND_SOAP',
    });
    expect(of(r, 'labeling.station').target?.station).toEqual({
      mode: 'LABELING',
      categoryCode: null,
    });
    expect(of(r, 'labeling.crate')).toMatchObject({ state: 'OK', count: 1 });
    expect(of(r, 'labeling.labelStock')).toMatchObject({ state: 'OK', count: 10 });
    // Labelling never waits for filling: no liquid and no pumps yet.
    expect(of(r, 'filling.liquid')).toMatchObject({ state: 'MISSING', count: 0 });
    expect(of(r, 'filling.pumps')).toMatchObject({ state: 'MISSING', count: 0 });

    // Two bottles labelled into the crate (capacity 2): it waits for filling.
    const session = await labelingSession(su);
    await setContext(su, session, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: lot,
    }).expect(200);
    await loadCrate(su, session, crateUrl).expect(200);
    for (const b of bottles.slice(0, 2))
      expect((await labelScan(su, session, b.url)).status).toBe(200);
    await receiveItem(su, kit.liquidItemId, 700);
    await receiveItem(su, kit.pumpItemId, 5);
    r = await get();
    expect(of(r, 'labeling.labels')).toMatchObject({ count: 1 }); // one still unlabelled
    expect(of(r, 'labeling.crate')).toMatchObject({ state: 'MISSING', count: 0 }); // full now
    expect(of(r, 'filling.crates')).toMatchObject({ state: 'OK', count: 1 });
    expect(of(r, 'filling.liquid')).toMatchObject({
      state: 'OK',
      count: 2, // 700 ml in one lot / 330
      recipe: { version: 1, waitingCrates: 1 },
    });
    expect(of(r, 'filling.pumps')).toMatchObject({ state: 'OK', count: 5 });
    expect(r.crates).toEqual({ openAssembly: 0, readyToFill: 1, filling: 0, filled: 0 });
  });

  it('never widens access: items without their permission are UNAVAILABLE; operators are refused', async () => {
    // The production operator works — the setup overview is not for them.
    const operator = await createUser(['PRODUCTION_OPERATOR']);
    expect((await as(operator).get('/api/admin/production/readiness')).status).toBe(403);

    // Stations and catalogue only: no stock, lots, crates or labels come back.
    const limited = await createUser([await stationRole()]);
    const res = await as(limited)
      .get('/api/admin/production/readiness')
      .query({ product: kit.productCode });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body as ProductionReadiness;
    for (const key of [
      'labeling.labels',
      'labeling.crate',
      'labeling.bottles',
      'labeling.labelStock',
      'filling.crates',
      'filling.liquid',
      'filling.pumps',
    ]) {
      expect(of(r, key), key).toMatchObject({
        key,
        state: 'UNAVAILABLE',
        count: null,
        href: null,
        reason: 'PERMISSION',
      });
    }
    // The site has a warehouse, but this role may not manage sites: no link, ask instead.
    expect(of(r, 'setup.warehouse')).toMatchObject({ state: 'OK' });
    expect(r.crates).toBeNull();
    expect(of(r, 'labeling.station').state).not.toBe('UNAVAILABLE');
    for (const key of ['labeling.labels', 'filling.liquid', 'labeling.labelStock']) {
      expect(of(r, key).target, key).toBeNull(); // no context without the permission
    }
    expect(JSON.stringify(r)).not.toMatch(/GR-\d|price|unitPrice/);
  });

  it('liquid in whole doses per lot, never pooled across lots (PR #28 UI28-R1)', async () => {
    const k = await labelingKit(su, { capacity: 1, labelStock: 0 });
    const r0 = async () =>
      of(await get({ product: k.productCode }), 'filling.liquid') as ReadinessItem;
    expect(await r0()).toMatchObject({ state: 'MISSING', count: 0 });
    // 200 + 200 ml: pooled 400 ml would say 1 bottle, but a bottle takes its 330 ml from ONE lot.
    await receiveItem(su, k.liquidItemId, 200);
    await receiveItem(su, k.liquidItemId, 200);
    expect(await r0()).toMatchObject({ state: 'MISSING', count: 0 });
    // + 500 + 500 ml: 2 whole doses (one per 500 ml lot) — pooled 1400 ml would say 4.
    await receiveItem(su, k.liquidItemId, 500);
    await receiveItem(su, k.liquidItemId, 500);
    expect(await r0()).toMatchObject({ state: 'OK', count: 2 });
  });

  it('filling is judged by the recipe pinned on the waiting crates, not the active one (UI28-R2)', async () => {
    const k = await labelingKit(su, { capacity: 1, labelStock: 10 });
    const api = '/api/admin/catalog';
    // One crate labelled under V1 (liquid A, pump A) waits for filling.
    const [bottle] = await printedBottles(su, 1);
    const versionId = (
      await su.prisma.bottle.findUniqueOrThrow({
        where: { id: bottle!.id },
        include: { creationBatch: true },
      })
    ).creationBatch.labelTemplateVersionId;
    await approveDesign(su, k.productCode, versionId);
    const crateUrl = await registerCrate(su, k.crateTypeCode);
    const lot = (await receiveBottles(su, 2)).lines[0]!.lot!.id;
    const session = await labelingSession(su);
    await setContext(su, session, {
      productCode: k.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: lot,
    }).expect(200);
    await loadCrate(su, session, crateUrl).expect(200);
    expect((await labelScan(su, session, bottle!.url)).status).toBe(200);

    // V2 becomes active with another liquid B and pump B; only B's liquid is in stock.
    const component = async (body: Record<string, unknown>) =>
      (
        await request(su.app.getHttpServer())
          .post(`${api}/components`)
          .send({
            requestId: randomUUID(),
            reason: 'komponenta receptury V2',
            packageCapacity: null,
            ...body,
          })
          .expect(201)
      ).body as { code: string };
    const liquidB = await component({
      kind: 'BULK_LIQUID',
      code: `LIQB-${sfx()}`,
      name: 'Kapalina B',
      unitCode: 'ml',
      lotTracked: true,
      categoryCode: 'HAND_SOAP',
    });
    const pumpB = await component({
      kind: 'PUMP',
      code: `PMPB-${sfx()}`,
      name: 'Pumpička B',
      unitCode: 'pcs',
      lotTracked: false,
      categoryCode: null,
    });
    await request(su.app.getHttpServer())
      .post(`${api}/products/${k.productCode}/recipes`)
      .send({
        requestId: randomUUID(),
        reason: 'návrh receptury V2',
        crateTypeCode: k.crateTypeCode,
        components: [
          { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: k.labelItemCode, quantity: '1', unitCode: 'pcs' },
          { itemCode: liquidB.code, quantity: '330', unitCode: 'ml' },
          { itemCode: pumpB.code, quantity: '1', unitCode: 'pcs' },
        ],
      })
      .expect(201);
    await request(su.app.getHttpServer())
      .post(`${api}/products/${k.productCode}/recipes/2/activate`)
      .send({ requestId: randomUUID(), reason: 'V2 schválena', expectedActiveVersion: 1 })
      .expect(200);
    const liquidBId = (
      await su.prisma.inventoryItem.findUniqueOrThrow({ where: { code: liquidB.code } })
    ).id;
    await receiveItem(su, liquidBId, 3300);
    await receiveItem(su, k.pumpItemId, 3); // pump A only

    const movements = await su.prisma.inventoryMovement.count();
    const cycles = await su.prisma.crateCycle.findMany({
      where: { product: { code: k.productCode } },
      select: { id: true, status: true, recipeVersionId: true },
    });
    const r = await get({ product: k.productCode });
    const liquid = r.filling.filter((i) => i.key === 'filling.liquid');
    const pumps = r.filling.filter((i) => i.key === 'filling.pumps');
    // Only the pinned V1 is judged: B in stock does not make the V1 crate fillable…
    expect(liquid).toEqual([
      expect.objectContaining({
        state: 'MISSING',
        count: 0,
        recipe: { version: 1, waitingCrates: 1 },
      }),
    ]);
    // The next step receives liquid A of the pinned V1, never B of the active V2.
    expect(liquid[0]!.target?.item?.code).toBe(
      (await su.prisma.inventoryItem.findUniqueOrThrow({ where: { id: k.liquidItemId } })).code,
    );
    // …and pump B missing (V2) is not reported against the crate whose pump A is in stock.
    expect(pumps).toEqual([
      expect.objectContaining({ state: 'OK', count: 3, recipe: { version: 1, waitingCrates: 1 } }),
    ]);
    expect(of(r, 'filling.crates')).toMatchObject({ state: 'OK', count: 1 });
    // Read-only: nothing moved, the pinned version untouched.
    expect(await su.prisma.inventoryMovement.count()).toBe(movements);
    expect(
      await su.prisma.crateCycle.findMany({
        where: { product: { code: k.productCode } },
        select: { id: true, status: true, recipeVersionId: true },
      }),
    ).toEqual(cycles);
  });

  it('a producing site without a warehouse says so instead of zero stock (UI28-R3)', async () => {
    const site = (
      await as(admin)
        .post('/api/admin/sites', {
          code: `RDY-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Nový závod',
          countryCode: 'SK',
          addressLine1: 'Testovacia 1',
          addressLine2: null,
          postalCode: '811 01',
          city: 'Bratislava',
          timeZone: 'Europe/Bratislava',
          defaultLocale: 'sk-SK',
          defaultCurrency: 'EUR',
          capabilities: ['WAREHOUSE', 'PRODUCTION'],
          reason: 'site without a warehouse yet',
        })
        .expect(201)
    ).body as SiteDetail;
    const read = async (cookie: string) => {
      const res = await as(cookie)
        .get('/api/admin/production/readiness')
        .query({ product: kit.productCode });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as ProductionReadiness;
    };
    const stockKeys = [
      'labeling.bottles',
      'labeling.labelStock',
      'filling.liquid',
      'filling.pumps',
    ];
    await as(admin).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    try {
      let r = await read(admin);
      expect(of(r, 'setup.site')).toMatchObject({ state: 'OK' });
      expect(of(r, 'setup.warehouse')).toMatchObject({
        state: 'MISSING',
        count: 0,
        href: '/admin/sites',
      });
      for (const key of stockKeys) {
        expect(of(r, key), key).toMatchObject({
          state: 'UNAVAILABLE',
          count: null,
          href: null,
          reason: 'NO_WAREHOUSE',
        });
      }
      // A role without sites:manage and inventory:read: no link, no stock, no new data.
      const limited = await createUser([await stationRole()], site.id);
      const l = await read(limited);
      expect(of(l, 'setup.warehouse')).toMatchObject({ state: 'MISSING', count: 0, href: null });
      for (const key of stockKeys) {
        expect(of(l, key), key).toMatchObject({ state: 'UNAVAILABLE', reason: 'PERMISSION' });
      }

      // The warehouse exists, still empty: now it is real zero stock.
      await as(admin)
        .post(`/api/admin/sites/${site.id}/warehouses`, {
          requestId: randomUUID(),
          code: `${site.code}-W`,
          name: 'Sklad',
          reason: 'first warehouse',
        })
        .expect(201);
      r = await read(admin);
      expect(of(r, 'setup.warehouse')).toMatchObject({ state: 'OK', count: 1 });
      for (const key of stockKeys) {
        expect(of(r, key), key).toMatchObject({ state: 'MISSING', count: 0, reason: null });
      }
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
  });
});
