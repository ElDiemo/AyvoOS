import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HotelDetail, PortalDeliveries } from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { SupplyPlansService } from '../src/orders/supply-plans.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import {
  cancelOrder,
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  pragueToday,
  scanCrate,
} from './support/order-fixtures.js';
import { deliver, pickUp, RETURN_ENV, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const portalToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
const otp = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
const client = () => ({
  ip: `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`,
  origin: PORTAL_ORIGIN,
  secFetchSite: 'same-origin',
});

/**
 * "Dodávky" through the core's portal contract and the real database: a granted hotel's real
 * orders in three groups with their states — open and picked (planned), labelled or with the FAKE
 * test carrier (in progress), delivered as proven by the carrier — never cancelled orders, another
 * hotel's orders or internal details (site, crates, people). Synthetic data and the simulated
 * carrier only, never the real PPL.
 */
describe.skipIf(!hasDatabase)('hotel portal: deliveries', () => {
  let t: TestApp;
  let su: TestApp;
  let adminId: string;
  let hotel: HotelDetail;
  let other: HotelDetail;
  let codes: Record<string, string>;
  let product: string;

  const core = () => request(t.app.getHttpServer());
  const get = (path: string, session?: string, token = portalToken) => {
    const r = core().get(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const post = (path: string) =>
    core().post(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${portalToken}`);
  const grant = (userId: string, hotelIds: string[]) =>
    t.app.get(PortalGrantsService).issue(adminId, {
      requestId: randomUUID(),
      userId,
      payerCustomerId: randomUUID(),
      hotelIds,
      reason: 'synthetic portal grant',
      financeCheck: { payerVersion: 1, hotelIds, checkedAt: new Date().toISOString() },
    });

  async function account() {
    const user = await t.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal user', audience: 'PORTAL' },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'synthetic portal invitation', 'PORTAL');
    const tokens = t.app.get(NativeTokensService);
    await tokens.deliverPending();
    const mail = tokens.deliveriesForTest().findLast((m) => m.to === user.email)!;
    const step = await post('auth/activate').send({
      token: tokenOf(mail.url),
      password: PASSWORD,
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    const done = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: otp(step.body.setupKey),
      client: client(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { user, session: done.body.session as string };
  }

  beforeAll(async () => {
    t = await createTestApp(
      {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
        PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
        FINANCE_SERVICE_TOKEN_SHA256: sha(financeToken),
        PORTAL_DB_ACQUIRE_TIMEOUT_MS: '1500',
        PORTAL_DB_STATEMENT_TIMEOUT_MS: '5000',
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    su = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    adminId = (
      await t.prisma.user.create({ data: { email: unique('grant-admin'), displayName: 'Admin' } })
    ).id;
    const factory = await crateFactory(su, { capacity: 2 });
    product = factory.kit.productCode;
    hotel = await createHotel(su, { name: 'Hotel Dodávky' });
    other = await createHotel(su, { name: 'Hotel Cizí dodávky' });

    const planned = await createOrder(su, hotel.code, [{ productCode: product, crates: 1 }]);
    const prepared = await createOrder(su, hotel.code, [{ productCode: product, crates: 1 }]);
    const r = await scanCrate(su, prepared.code, (await factory.make()).crateUrl);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await completeOrder(su, prepared.code).expect(200);
    const ready = await shipCrates(su, hotel.code, product, [await factory.make()]);
    const transit = await shipCrates(su, hotel.code, product, [await factory.make()]);
    await pickUp(su, transit);
    const done = await shipCrates(su, hotel.code, product, [await factory.make()]);
    await pickUp(su, done);
    await deliver(su, done);
    const cancelled = await createOrder(su, hotel.code, [{ productCode: product, crates: 1 }]);
    await cancelOrder(su, cancelled.code).expect(200);
    const foreign = await createOrder(su, other.code, [{ productCode: product, crates: 1 }]);
    codes = {
      planned: planned.code,
      prepared: prepared.code,
      ready: ready.order,
      transit: transit.order,
      done: done.order,
      cancelled: cancelled.code,
      foreign: foreign.code,
    };
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
    await su?.close();
  });

  it('three groups from the real orders, with the hotel-facing states only', async () => {
    const a = await account();
    await grant(a.user.id, [hotel.id]);
    const res = await get(`hotels/${hotel.id}/deliveries`, a.session);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body as PortalDeliveries;
    const states = (list: PortalDeliveries['planned']) =>
      Object.fromEntries(list.map((o) => [o.code, o.state]));
    expect(states(d.planned)).toEqual({
      [codes.planned!]: 'PLANNED',
      [codes.prepared!]: 'PREPARED',
    });
    expect(states(d.inProgress)).toEqual({
      [codes.ready!]: 'READY_FOR_PICKUP',
      [codes.transit!]: 'IN_TRANSIT',
    });
    expect(states(d.delivered)).toEqual({ [codes.done!]: 'DELIVERED' });
    const all = [...d.planned, ...d.inProgress, ...d.delivered].map((o) => o.code);
    expect(all).not.toContain(codes.cancelled);
    expect(all).not.toContain(codes.foreign);

    const transit = d.inProgress.find((o) => o.code === codes.transit)!;
    expect(transit.handedOverAt).not.toBeNull();
    expect(transit.deliveredAt).toBeNull();
    const delivered = d.delivered[0]!;
    expect(delivered.handedOverAt).not.toBeNull();
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.lines).toEqual([{ product: expect.any(String), crates: 1, bottles: 2 }]);
    expect(delivered.fromPlan).toBe(false);
    expect(d.upcoming).toEqual([]); // no supply plan
    // Nothing internal: no site, crates, people, carrier account or labels.
    for (const o of [...d.planned, ...d.inProgress, ...d.delivered])
      expect(Object.keys(o).sort()).toEqual(
        ['code', 'deliveredAt', 'fromPlan', 'handedOverAt', 'lines', 'shipDate', 'state'].sort(),
      );
  });

  it('upcoming days of a switched-on plan, without days already ordered; nothing when paused', async () => {
    const planned = await createHotel(su, { name: 'Hotel Plán dodávek' });
    const base = `/api/admin/orders/hotel/${planned.code}/supply-plan`;
    const http = () => request(su.app.getHttpServer());
    await http()
      .post(base)
      .send({
        requestId: randomUUID(),
        reason: 'plán podle smlouvy',
        validFrom: pragueToday(),
        validTo: null,
        rules: [{ productCode: product, crates: 2, days: [5, 20] }],
      })
      .expect(200);
    const { version } = (await http().get(`${base}/preview`).expect(200)).body as {
      version: number;
    };
    await http()
      .post(`${base}/activate`)
      .send({ requestId: randomUUID(), confirm: true, version })
      .expect(200);
    const a = await account();
    await grant(a.user.id, [planned.id]);
    const read = async () =>
      (await get(`hotels/${planned.id}/deliveries`, a.session).expect(200))
        .body as PortalDeliveries;

    // Before the plan's round: every plan day of the next 60 days, whole crates only.
    const before = await read();
    const today = pragueToday();
    const last = pragueToday(59);
    expect(before.upcoming.length).toBeGreaterThanOrEqual(3);
    for (const day of before.upcoming) {
      expect(day.shipDate >= today && day.shipDate <= last).toBe(true);
      expect(['05', '20']).toContain(day.shipDate.slice(8));
      expect(day.lines).toEqual([{ product: expect.any(String), crates: 2 }]);
    }
    expect(before.planned).toEqual([]);

    // The round orders the days inside its horizon: those become deliveries, the rest stay ahead.
    await su.app.get(SupplyPlansService).runDue();
    const after = await read();
    const ordered = after.planned.map((o) => o.shipDate);
    expect(after.planned.every((o) => o.fromPlan)).toBe(true);
    expect(after.upcoming.map((d) => d.shipDate).some((day) => ordered.includes(day))).toBe(false);
    expect([...ordered, ...after.upcoming.map((d) => d.shipDate)].sort()).toEqual(
      before.upcoming.map((d) => d.shipDate).sort(),
    );

    await http()
      .post(`${base}/pause`)
      .send({ requestId: randomUUID(), reason: 'hotel v rekonstrukci' })
      .expect(200);
    const paused = await read();
    expect(paused.upcoming).toEqual([]);
    expect(paused.planned.map((o) => o.code)).toEqual(after.planned.map((o) => o.code));
  });

  it('another hotel or an unknown id is “not found”; without a session or with Finance’s token 401', async () => {
    const a = await account();
    await grant(a.user.id, [hotel.id]);
    for (const id of [other.id, randomUUID()]) {
      const r = await get(`hotels/${id}/deliveries`, a.session);
      expect([r.status, r.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    }
    expect((await get(`hotels/${hotel.id}/deliveries`)).status).toBe(401);
    expect((await get(`hotels/${hotel.id}/deliveries`, a.session, financeToken)).status).toBe(401);
  });

  it('a revoked grant ends access to the hotel’s deliveries', async () => {
    const a = await account();
    await grant(a.user.id, [other.id]);
    const g = await grant(a.user.id, [hotel.id]);
    expect((await get(`hotels/${hotel.id}/deliveries`, a.session)).status).toBe(200);
    await t.app.get(PortalGrantsService).revoke(adminId, g.id, 'synthetic revocation');
    expect((await get(`hotels/${hotel.id}/deliveries`, a.session)).status).toBe(404);
    const theirs = await get(`hotels/${other.id}/deliveries`, a.session);
    expect(theirs.status).toBe(200);
    expect((theirs.body as PortalDeliveries).planned.map((o) => o.code)).toEqual([codes.foreign]);
  });
});
