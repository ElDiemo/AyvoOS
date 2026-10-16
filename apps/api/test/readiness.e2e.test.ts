import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, ProductionReadiness, ReadinessItem } from '@ayvo/types';
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
    expect(of(r, 'filling.liquid')).toMatchObject({ state: 'OK', count: 2 }); // 700 ml / 330
    expect(of(r, 'filling.pumps')).toMatchObject({ state: 'OK', count: 5 });
    expect(r.crates).toEqual({ openAssembly: 0, readyToFill: 1, filling: 0, filled: 0 });
  });

  it('never widens access: items without their permission are UNAVAILABLE; operators are refused', async () => {
    const createUser = async (roles: string[]) => {
      const res = await as(admin).post('/api/admin/identity/users', {
        email: `ready-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: `Uživatel ${randomUUID().slice(0, 4)}`,
        roles,
        siteIds: [INITIAL_SITE_ID],
        warehouseCodes: [],
        reason: 'readiness access test',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const cookie = await sessionCookie(ra, (res.body as AdminUserDetail).email);
      await as(cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
      return cookie;
    };
    // The production operator works — the setup overview is not for them.
    const operator = await createUser(['PRODUCTION_OPERATOR']);
    expect((await as(operator).get('/api/admin/production/readiness')).status).toBe(403);

    // Stations and catalogue only: no stock, lots, crates or labels come back.
    const code = `STATION_ADMIN_${randomUUID().slice(0, 6).toUpperCase()}`;
    const role = await as(admin).post('/api/admin/identity/roles', {
      code,
      name: 'Správce pracovišť',
      description: 'Pracoviště a katalog bez skladu',
      permissions: ['production:workstations_manage', 'catalog:read'],
      reason: 'readiness test role',
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const limited = await createUser([code]);
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
      expect(of(r, key), key).toEqual({ key, state: 'UNAVAILABLE', count: null, href: null });
    }
    expect(r.crates).toBeNull();
    expect(of(r, 'labeling.station').state).not.toBe('UNAVAILABLE');
    expect(JSON.stringify(r)).not.toMatch(/GR-\d|price|unitPrice/);
  });
});
