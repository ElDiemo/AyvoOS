import { randomUUID } from 'node:crypto';
import type { BottleCirculation, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { crateFactory, createHotel } from './support/order-fixtures.js';
import { deliver, pickUp, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * R3-c (doc 048 §3.0a): the operating view of bottles, read only — readiness source, crate binding
 * and location apart, each derived from existing records. A printed code is nowhere ("—"); a
 * mixed return moves only the bottles scanned individually back to the site, whatever crate they
 * came in; the delivered order keeps its content; another site's bottle is never shown.
 */
describe.skipIf(!hasDatabase)('R3-c: the bottle circulation view', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  const http = () => request(t.app.getHttpServer());
  const view = async (...codes: string[]) => {
    const r = await http()
      .get('/api/admin/bottle-circulation')
      .query({ codes: codes.join(',') });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return new Map((r.body.items as BottleCirculation[]).map((i) => [i.code, i]));
  };
  const codeOf = async (id: string) =>
    (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).code;

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Poloha' })).code;
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });

  it('a printed code is nowhere; a labelled bottle in its crate is at the site, "K plnění · Nová"', async () => {
    const made = await factory.make('READY_TO_FILL');
    const printed = await t.prisma.bottle.findFirstOrThrow({
      where: { status: 'CREATED', printJobItems: { some: {} } },
      orderBy: { serial: 'desc' },
    });
    const [a] = await Promise.all([codeOf(made.bottleIds[0]!)]);
    const v = await view(a!, printed.code);
    expect(v.get(printed.code)).toEqual({
      code: printed.code,
      source: null,
      crate: null,
      location: { kind: 'NONE', orderCode: null, hotelName: null, deliveredAt: null },
    });
    expect(v.get(a!)).toEqual({
      code: a,
      source: 'NEW',
      crate: { code: made.crateCode, cycleStatus: 'READY_TO_FILL' },
      location: { kind: 'AT_SITE', orderCode: null, hotelName: null, deliveredAt: null },
    });
    // Bad input is refused, nothing is guessed.
    await http().get('/api/admin/bottle-circulation').query({ codes: 'nonsense' }).expect(400);
  });

  it('with the carrier, then at the hotel; a mixed return brings back only the bottles scanned individually; the order keeps its content', async () => {
    const k = await factory.make();
    const l = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [k, l]);
    const [k1, k2, l1, l2] = await Promise.all(
      [...k.bottleIds, ...l.bottleIds].map((id) => codeOf(id)),
    );
    await pickUp(t, shipped);
    let v = await view(k1!, l1!);
    expect(v.get(k1!)!.location).toMatchObject({ kind: 'IN_TRANSIT', orderCode: shipped.order });
    expect(v.get(k1!)!.crate).toEqual({ code: k.crateCode, cycleStatus: 'DISPATCHED' });
    await deliver(t, shipped);
    v = await view(k1!, k2!, l1!, l2!);
    for (const c of [k1, k2, l1, l2]) {
      expect(v.get(c!)!.location.kind).toBe('AT_HOTEL');
      expect(v.get(c!)!.location.orderCode).toBe(shipped.order);
      expect(v.get(c!)!.location.hotelName).toBe('Hotel Poloha');
      expect(v.get(c!)!.location.deliveredAt).not.toBeNull();
    }

    // The mixed return: crate K scanned back; in K's line K's first bottle and L's first bottle.
    const api = returnsApi(t);
    const receipt = await api.open();
    const line = (await api.scanCrate(receipt.code, k.crateUrl)).body.lineId as string;
    await api.scanBottle(receipt.code, line, k.bottleUrls[0]!, 'GOOD').expect(200);
    await api.scanBottle(receipt.code, line, l.bottleUrls[0]!, 'GOOD').expect(200);
    v = await view(k1!, k2!, l1!, l2!);
    expect(v.get(k1!)!.location.kind).toBe('AT_SITE');
    expect(v.get(l1!)!.location.kind).toBe('AT_SITE');
    // Never derived from the crate scan: K's unscanned bottle and L's other bottle stay at the hotel.
    expect(v.get(k2!)!.location).toMatchObject({ kind: 'AT_HOTEL', orderCode: shipped.order });
    expect(v.get(l2!)!.location).toMatchObject({ kind: 'AT_HOTEL', orderCode: shipped.order });
    expect(v.get(k1!)!.source).toBe('NEW');

    // "Po mytí": the same next step "K plnění", its source now after washing, in no crate.
    const washed = await http()
      .post('/api/admin/returns/after-wash')
      .send({ requestId: randomUUID(), scannedValue: k.bottleUrls[0]! });
    expect(washed.status, JSON.stringify(washed.body)).toBe(200);
    v = await view(k1!);
    expect(v.get(k1!)).toMatchObject({ source: 'AFTER_WASH', crate: null });
    expect(v.get(k1!)!.location.kind).toBe('AT_SITE');

    // The delivered order keeps its content: both crates, two bottles each, and the picked bottles.
    const order = (await http().get(`/api/admin/orders/${shipped.order}`).expect(200)).body as {
      crates: { crate: string; bottles: number }[];
    };
    expect(order.crates.map((c) => [c.crate, c.bottles]).sort()).toEqual(
      [
        [k.crateCode, 2],
        [l.crateCode, 2],
      ].sort(),
    );
    expect(
      await t.prisma.orderAllocationBottle.count({
        where: { allocation: { order: { code: shipped.order } } },
      }),
    ).toBe(4);
  });

  it('another site never sees the bottle (real sign-in, the active site decides)', async () => {
    const ra = await createTestApp(RETURN_ENV, {}, { auth: 'real' });
    let adminId = '';
    try {
      const made = await factory.make('READY_TO_FILL');
      const code = await codeOf(made.bottleIds[0]!);
      const user = await prepareInvitedUser(ra, {
        email: `circulation-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: 'Circulation Admin',
      });
      adminId = user.id;
      await ra.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
      });
      const cookie = await sessionCookie(ra, user.email);
      const as = () => request(ra.app.getHttpServer());
      const activeSite = (siteId: string) =>
        as().post('/api/auth/active-site').set('Cookie', cookie).send({ siteId }).expect(200);
      await activeSite(INITIAL_SITE_ID);
      const other = (
        await as()
          .post('/api/admin/sites')
          .set('Cookie', cookie)
          .send({
            requestId: randomUUID(),
            code: `RC-${randomUUID().slice(0, 4).toUpperCase()}`,
            name: 'Druhá provozovna (poloha)',
            countryCode: 'SK',
            addressLine1: 'Testovacia 3',
            addressLine2: null,
            postalCode: '811 03',
            city: 'Bratislava',
            timeZone: 'Europe/Bratislava',
            defaultLocale: 'sk-SK',
            defaultCurrency: 'EUR',
            capabilities: ['WAREHOUSE', 'PRODUCTION'],
            reason: 'second site',
          })
          .expect(201)
      ).body as SiteDetail;
      await as()
        .post(`/api/admin/sites/${other.id}/warehouses`)
        .set('Cookie', cookie)
        .send({
          requestId: randomUUID(),
          code: `${other.code}-W`,
          name: 'Sklad',
          reason: 'first warehouse',
        })
        .expect(201);
      const read = () =>
        as().get('/api/admin/bottle-circulation').query({ codes: code }).set('Cookie', cookie);
      expect(((await read().expect(200)).body.items as BottleCirculation[]).length).toBe(1);
      await activeSite(other.id);
      expect((await read().expect(200)).body).toEqual({ items: [] });
      await as().get(`/api/admin/bottles/${code}`).set('Cookie', cookie).expect(404);
    } finally {
      await ra.prisma.userRole.updateMany({
        where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'end of test' },
      });
      await ra.close();
    }
  });
});
