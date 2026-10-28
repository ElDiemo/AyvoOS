import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import {
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  scanCrate,
} from './support/order-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Dispatch permissions through REAL sign-in (doc 029 §6): shipments:read / prepare / handover
 * exist only for ADMIN; each step needs its own permission, checked again on every request —
 * also on the repetition of the same request id after the permission was removed; another site's
 * shipment is not found. The superuser app makes the synthetic completed orders.
 */
describe.skipIf(!hasDatabase)('dispatch access and site isolation (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let other: SiteDetail;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });
  const activeSite = (cookie: string, siteId: string) =>
    as(cookie).post('/api/auth/active-site', { siteId }).expect(200);

  async function createUser(roles: string[]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `ship-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Expedient ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'dispatch access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    const cookie = await sessionCookie(ra, user.email);
    await activeSite(cookie, INITIAL_SITE_ID);
    return { cookie, id: user.id };
  }
  async function role(permissions: string[]) {
    const code = `SHIP_${randomUUID().slice(0, 6).toUpperCase()}`;
    await as(admin)
      .post('/api/admin/identity/roles', {
        code,
        name: `Expedice ${code}`,
        description: 'Příprava přepravy',
        permissions,
        reason: 'dispatch test role',
      })
      .expect(201);
    return code;
  }
  /** A completed order of the initial site with one weighed parcel (the test carrier needs it). */
  async function completed() {
    const c = await factory.make();
    const order = await createOrder(su, hotel, [
      { productCode: factory.kit.productCode, crates: 1 },
    ]);
    expect((await scanCrate(su, order.code, c.crateUrl)).status).toBe(200);
    expect((await completeOrder(su, order.code)).status).toBe(200);
    await request(su.app.getHttpServer())
      .post(`/api/admin/orders/${order.code}/shipment/parcels/1/weighings`)
      .send({ requestId: randomUUID(), massG: '2500', correctionOf: null, correctionReason: null })
      .expect(200);
    return order.code;
  }

  beforeAll(async () => {
    su = await createTestApp({ CARRIER_PROVIDER: 'test', CARRIER_POLL_SECONDS: '0' });
    ra = await createTestApp(
      { CARRIER_PROVIDER: 'test', CARRIER_POLL_SECONDS: '0' },
      {},
      { auth: 'real' },
    );
    factory = await crateFactory(su);
    hotel = (await createHotel(su)).code;
    const user = await prepareInvitedUser(ra, {
      email: `ship-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Ship Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await activeSite(admin, INITIAL_SITE_ID);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `SH-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Jiný sklad',
        countryCode: 'SK',
        addressLine1: 'Testovacia 2',
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
  beforeEach(() => testCarrierControl.reset());
  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    testCarrierControl.reset();
    await ra?.close();
    await su?.close();
  });

  it('only ADMIN holds the dispatch permissions; existing roles gain nothing', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: {
        permissionCode: {
          in: [
            'shipments:read',
            'shipments:prepare',
            'shipments:handover',
            'shipments:resolve_uncertain',
          ],
        },
        role: { isSystem: true },
      },
      select: { roleCode: true },
    });
    expect([...new Set(holders.map((h) => h.roleCode))]).toEqual(['ADMIN']);
    const order = await completed();
    for (const r of ['WAREHOUSE_SUPERVISOR', 'PRODUCTION_SUPERVISOR', 'WAREHOUSE_OPERATOR']) {
      const { cookie } = await createUser([r]);
      expect((await as(cookie).get(`/api/admin/orders/${order}/shipment`)).status, r).toBe(403);
    }
  });

  it('carrier settings: ADMIN only (sites:carrier_manage); no secret or API URL in the answer', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: { permissionCode: 'sites:carrier_manage' },
      select: { roleCode: true },
    });
    expect(holders.map((h) => h.roleCode)).toEqual(['ADMIN']);
    const url = `/api/admin/sites/${INITIAL_SITE_ID}/carriers/ppl`;
    const supervisor = await createUser(['WAREHOUSE_SUPERVISOR']);
    const dispatcher = await createUser([
      await role(['orders:read', 'shipments:read', 'shipments:prepare', 'shipments:handover']),
    ]);
    for (const u of [supervisor, dispatcher]) {
      expect((await as(u.cookie).get(url)).status).toBe(403);
      expect((await as(u.cookie).post(`${url}/verify`, { requestId: randomUUID() })).status).toBe(
        403,
      );
      expect(
        (
          await http()
            .put(url)
            .set('Cookie', u.cookie)
            .send({ requestId: randomUUID(), enabled: true })
        ).status,
      ).toBe(403);
    }
    // Carrier connections (credentials): ADMIN only as well; a custom role can never hold it.
    for (const u of [supervisor, dispatcher]) {
      expect((await as(u.cookie).get('/api/admin/carrier-connections')).status).toBe(403);
      // The test and the production connection alike (ADR 0042).
      for (const code of ['PPL_TEST', 'PPL_PRODUCTION']) {
        expect(
          (
            await http()
              .post(`/api/admin/carrier-connections/${code}/credentials`)
              .set('Cookie', u.cookie)
              .send({
                requestId: randomUUID(),
                clientId: 'a',
                clientSecret: 'b',
                reason: 'not mine',
              })
          ).status,
          code,
        ).toBe(403);
      }
      // Nor may they switch a site to production PPL, confirmed or not.
      expect(
        (
          await http()
            .put(url)
            .set('Cookie', u.cookie)
            .send({ requestId: randomUUID(), enabled: true, connection: 'PPL_PRODUCTION' })
        ).status,
      ).toBe(403);
    }
    const conn = await ra.prisma.rolePermission.findMany({
      where: { permissionCode: 'carriers:connections_manage' },
      select: { roleCode: true },
    });
    expect(conn.map((h) => h.roleCode)).toEqual(['ADMIN']);
    await as(admin).get('/api/admin/carrier-connections').expect(200);
    const own = await as(admin).get(url).expect(200);
    const theirs = await as(admin).get(`/api/admin/sites/${other.id}/carriers/ppl`).expect(200);
    expect([own.body.site.id, theirs.body.site.id]).toEqual([INITIAL_SITE_ID, other.id]);
    expect(theirs.body.saved).toBe(false);
    expect(JSON.stringify(own.body)).not.toMatch(/secret|token|https?:\/\//i);
  });

  it('printing (doc 030): every action needs its own permission; printers are security administration', async () => {
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    const suffix = randomUUID().slice(0, 4).toUpperCase();
    const printingUrl = `/api/admin/sites/${INITIAL_SITE_ID}/printing`;
    const agent = (
      await as(admin)
        .post(`${printingUrl}/agents`, {
          requestId: randomUUID(),
          code: `RPI-P-${suffix}`,
          name: 'Pi',
        })
        .expect(200)
    ).body as { agent: { id: string } };
    const saved = (
      await as(admin)
        .post(`${printingUrl}/printers`, {
          requestId: randomUUID(),
          id: null,
          code: `ZD-P-${suffix}`,
          name: 'Zebra expedice',
          model: 'ZEBRA_ZD220_DT',
          agentId: agent.agent.id,
          usbSerial: `P${suffix}`,
          dispatchDefault: true,
          autoPrint: true,
          enabled: true,
        })
        .expect(200)
    ).body as { printers: { id: string; code: string }[] };
    const printerId = saved.printers.find((p) => p.code === `ZD-P-${suffix}`)!.id;
    const c = await factory.make();
    const order = (
      await createOrder(su, hotel, [{ productCode: factory.kit.productCode, crates: 1 }])
    ).code;
    expect((await scanCrate(su, order, c.crateUrl)).status).toBe(200);
    const combined = (cookie: string, printer: string | null, requestId = randomUUID()) =>
      as(cookie).post(`/api/admin/orders/${order}/complete-and-label`, {
        requestId,
        printerId: printer,
      });
    const status = async () =>
      (
        (await request(su.app.getHttpServer()).get(`/api/admin/orders/${order}`)).body as {
          status: string;
        }
      ).status;
    // Completing without preparing the shipment is not this action.
    const onlyPick = await createUser([await role(['orders:read', 'orders:pick'])]);
    expect((await combined(onlyPick.cookie, null)).status).toBe(403);
    // Completing and labelling, but printing is not allowed: refused BEFORE anything is done.
    const picker = await createUser([
      await role(['orders:read', 'orders:pick', 'shipments:read', 'shipments:prepare']),
    ]);
    const refused = await combined(picker.cookie, printerId);
    expect([refused.status, refused.body.code]).toEqual([403, 'FORBIDDEN']);
    expect(await status()).toBe('OPEN');
    expect(testCarrierControl.calls).toHaveLength(0);
    // Without printing: completed and labelled, nothing printed.
    expect((await combined(picker.cookie, null)).status).toBe(200);
    expect(await ra.prisma.printJob.count({ where: { order: { code: order } } })).toBe(0);
    // The ZPL file for the printer only with printing:print; the PDF preview for any reader.
    expect(
      (await as(picker.cookie).get(`/api/admin/orders/${order}/shipment/parcels/1/label`)).status,
    ).toBe(200);
    expect(
      (await as(picker.cookie).get(`/api/admin/orders/${order}/shipment/parcels/1/label/zpl`))
        .status,
    ).toBe(403);
    const print = (cookie: string, requestId = randomUUID()) =>
      as(cookie).post(`/api/admin/orders/${order}/shipment/print`, { requestId, printerId });
    expect((await print(picker.cookie)).status).toBe(403);
    const printer = await createUser([
      await role(['orders:read', 'shipments:read', 'printing:print']),
    ]);
    const id = randomUUID();
    expect((await print(printer.cookie, id)).status).toBe(200);
    expect(
      (await as(printer.cookie).get(`/api/admin/orders/${order}/shipment/parcels/1/label/zpl`))
        .status,
    ).toBe(200);
    // Printing again is a separate permission.
    const reprint = (cookie: string) =>
      as(cookie).post(`/api/admin/orders/${order}/shipment/parcels/1/reprint`, {
        requestId: randomUUID(),
        printerId,
        reason: 'Štítek poškozen',
        acknowledgeDuplicate: true,
      });
    expect((await reprint(printer.cookie)).status).toBe(403);
    // Printers and agents: security administration — never a custom role, never anyone but ADMIN.
    expect((await as(printer.cookie).get(printingUrl)).status).toBe(403);
    const managerRole = await as(admin).post('/api/admin/identity/roles', {
      code: `PRN_${suffix}`,
      name: `Tiskárny ${suffix}`,
      description: 'Správa tiskáren',
      permissions: ['printing:manage'],
      reason: 'must be refused',
    });
    expect(managerRole.status).toBeGreaterThanOrEqual(400);
    const holders = await ra.prisma.rolePermission.findMany({
      where: {
        permissionCode: { in: ['printing:print', 'printing:reprint', 'printing:manage'] },
        role: { isSystem: true },
      },
      select: { roleCode: true },
    });
    expect([...new Set(holders.map((h) => h.roleCode))]).toEqual(['ADMIN']);
    // The permission removed: the very same request id is refused too.
    await ra.prisma.userRole.updateMany({
      where: { userId: printer.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'test: role removed' },
    });
    expect((await print(printer.cookie, id)).status).toBe(403);
  });

  it('each step needs its own permission, checked again on every request and repetition', async () => {
    const order = await completed();
    const reader = await createUser([await role(['orders:read', 'shipments:read'])]);
    const preparer = await createUser([
      await role(['orders:read', 'shipments:read', 'shipments:prepare']),
    ]);
    const onlyOrders = await createUser([await role(['orders:read'])]);
    expect((await as(onlyOrders.cookie).get(`/api/admin/orders/${order}/shipment`)).status).toBe(
      403,
    );
    expect((await as(reader.cookie).get(`/api/admin/orders/${order}/shipment`)).status).toBe(200);
    const labels = (cookie: string, requestId = randomUUID()) =>
      as(cookie).post(`/api/admin/orders/${order}/shipment/labels`, { requestId });
    expect((await labels(reader.cookie)).status).toBe(403);
    expect(testCarrierControl.calls).toHaveLength(0);
    const id = randomUUID();
    expect((await labels(preparer.cookie, id)).status).toBe(200);
    expect(
      (
        await as(preparer.cookie).post(`/api/admin/orders/${order}/shipment/ready`, {
          requestId: randomUUID(),
          labelsApplied: true,
        })
      ).status,
    ).toBe(200);
    // Preparing is not handing over.
    const handOver = (cookie: string) =>
      as(cookie).post(`/api/admin/orders/${order}/shipment/hand-over`, {
        requestId: randomUUID(),
        handedOver: true,
      });
    expect((await handOver(preparer.cookie)).status).toBe(403);
    // Closing an uncertain request by hand is a separate, exceptional permission.
    expect(
      (
        await as(preparer.cookie).post(`/api/admin/orders/${order}/shipment/abandon`, {
          requestId: randomUUID(),
          reason: 'nic nevzniklo',
        })
      ).status,
    ).toBe(403);
    // The permission removed: the very same request id is refused too (no replay around it).
    await ra.prisma.userRole.updateMany({
      where: { userId: preparer.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'test: role removed' },
    });
    expect((await labels(preparer.cookie, id)).status).toBe(403);
    expect((await as(preparer.cookie).get(`/api/admin/orders/${order}/shipment`)).status).toBe(403);
    expect(testCarrierControl.calls).toHaveLength(1);
    // "Obnovit tracking" (doc 031) belongs to those who confirm the hand-over.
    const refresh = (cookie: string) =>
      as(cookie).post(`/api/admin/orders/${order}/shipment/tracking/refresh`, {
        requestId: randomUUID(),
      });
    expect((await refresh(reader.cookie)).status).toBe(403);
    const handler = await createUser([await role(['orders:read', 'shipments:handover'])]);
    expect((await refresh(handler.cookie)).status).toBe(200);
    expect((await handOver(handler.cookie)).status).toBe(200);
  });

  it('another site’s shipment is not found, whatever is asked', async () => {
    const order = await completed();
    await activeSite(admin, other.id);
    for (const path of ['', '/labels', '/parcels/1/label']) {
      expect((await as(admin).get(`/api/admin/orders/${order}/shipment${path}`)).status).toBe(404);
    }
    for (const [path, body] of [
      ['/labels', {}],
      ['/resolve', {}],
      ['/ready', { labelsApplied: true }],
      ['/hand-over', { handedOver: true }],
      ['/tracking/refresh', {}],
      ['/parcels/1/weighings', { massG: '1', correctionOf: null, correctionReason: null }],
    ] as const) {
      const res = await as(admin).post(`/api/admin/orders/${order}/shipment${path}`, {
        requestId: randomUUID(),
        ...body,
      });
      expect(res.status, path).toBe(404);
    }
    expect(testCarrierControl.calls).toHaveLength(0);
    await activeSite(admin, INITIAL_SITE_ID);
  });
});
