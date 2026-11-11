import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PortalDeliveries } from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { crateFactory, createHotel } from './support/order-fixtures.js';
import { DELIVERED, look, PICKED_UP, RETURN_ENV, shipCrates } from './support/return-fixtures.js';
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
 * #169: a delivery is shown as delivered only when the carrier proved every parcel delivered
 * (doc 031). One parcel delivered, the other at a pick-up point or after a failed attempt, keeps
 * the order "Na cestě" without a delivery moment — never in "Doručené"; once both are delivered,
 * it moves there with the carrier's moment. The planned ship day never changes along the way.
 */
describe.skipIf(!hasDatabase)('hotel portal: delivered only when proven', () => {
  let t: TestApp;
  let su: TestApp;
  let adminId: string;

  const core = () => request(t.app.getHttpServer());
  const get = (path: string, session: string) =>
    core()
      .get(`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${portalToken}`)
      .set('x-ayvo-portal-session', session);
  const post = (path: string) =>
    core().post(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${portalToken}`);

  async function account() {
    const user = await t.prisma.user.create({
      data: { email: unique('portal-truth'), displayName: 'Portal user', audience: 'PORTAL' },
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
  });
  afterAll(async () => {
    await t?.close();
    await su?.close();
  });

  for (const [label, other] of [
    ['a pick-up point', 343],
    ['a failed attempt', 460],
  ] as const)
    it(`one parcel delivered, the other at ${label}: on the way, never delivered; both delivered: delivered`, async () => {
      const factory = await crateFactory(su, { capacity: 2 });
      const h = await createHotel(su, { name: `Hotel Pravda ${other}` });
      const a = await account();
      await t.app.get(PortalGrantsService).issue(adminId, {
        requestId: randomUUID(),
        userId: a.user.id,
        payerCustomerId: randomUUID(),
        hotelIds: [h.id],
        reason: 'synthetic portal grant',
        financeCheck: { payerVersion: 1, hotelIds: [h.id], checkedAt: new Date().toISOString() },
      });
      const o = await shipCrates(su, h.code, factory.kit.productCode, [
        await factory.make(),
        await factory.make(),
      ]);
      const [n1, n2] = o.numbers as [string, string];
      const read = async () =>
        (await get(`hotels/${h.id}/deliveries`, a.session).expect(200)).body as PortalDeliveries;
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(60) });
      testCarrierControl.track(n2, { statusId: PICKED_UP, at: at(60) });
      await look(su, o.shipmentId);
      const shipDay = (await read()).inProgress.find((x) => x.code === o.order)!.shipDate;
      testCarrierControl.track(n1, { statusId: DELIVERED, at: at(30) });
      testCarrierControl.track(n2, { statusId: other, at: at(20) });
      await look(su, o.shipmentId);
      const half = await read();
      const still = half.inProgress.find((x) => x.code === o.order)!;
      expect([still.state, still.deliveredAt, still.shipDate]).toEqual([
        'IN_TRANSIT',
        null,
        shipDay,
      ]);
      expect(still.handedOverAt).not.toBeNull();
      expect(half.delivered.map((x) => x.code)).not.toContain(o.order);
      testCarrierControl.track(n2, { statusId: DELIVERED, at: at(5) });
      await look(su, o.shipmentId);
      const done = await read();
      expect(done.inProgress.map((x) => x.code)).not.toContain(o.order);
      const delivered = done.delivered.find((x) => x.code === o.order)!;
      expect(delivered.state).toBe('DELIVERED');
      expect(delivered.deliveredAt).not.toBeNull();
      expect(delivered.shipDate).toBe(shipDay);
    });
});
