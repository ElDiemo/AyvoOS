import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HotelDetail, PortalDeliveries, PortalHotel } from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { crateFactory, createHotel, createOrder } from './support/order-fixtures.js';
import { RETURN_ENV } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { operationsCheck } from './support/portal-check.js';

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
 * The owner's isolation rule for the first hotel (2026-11-10): an account managing several hotels
 * sees exactly its hotels, and each hotel's own data only — never one granted hotel's orders under
 * another, never an ungranted hotel (404 on its detail, profile, deliveries and contracts), and
 * another account never sees them. Two shapes of "several hotels": one grant with two hotels, and
 * two grants (two payers). Synthetic data, the real core and database.
 */
describe.skipIf(!hasDatabase)(
  'hotel portal: isolation across several hotels of one account',
  () => {
    let t: TestApp;
    let su: TestApp;
    let adminId: string;
    const hotels: HotelDetail[] = [];
    const orders: string[] = [];

    const core = () => request(t.app.getHttpServer());
    const get = (path: string, session: string) =>
      core()
        .get(`/api/internal/v1/portal/${path}`)
        .set('Authorization', `Bearer ${portalToken}`)
        .set('x-ayvo-portal-session', session);
    const post = (path: string) =>
      core().post(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${portalToken}`);
    const grant = (userId: string, hotelIds: string[]) =>
      t.app.get(PortalGrantsService).issue(adminId, {
        requestId: randomUUID(),
        userId,
        payerCustomerId: randomUUID(),
        hotelIds,
        reason: 'synthetic portal grant',
        financeCheck: operationsCheck(hotelIds),
      });

    async function account() {
      const user = await t.prisma.user.create({
        data: { email: unique('portal-iso'), displayName: 'Portal user', audience: 'PORTAL' },
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
    const orderCodes = (d: PortalDeliveries) =>
      [...d.planned, ...d.inProgress, ...d.delivered].map((x) => x.code);

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
      adminId = (
        await t.prisma.user.create({ data: { email: unique('grant-admin'), displayName: 'Admin' } })
      ).id;
      const factory = await crateFactory(su, { capacity: 2 });
      for (const name of ['Hotel Izolace 1', 'Hotel Izolace 2', 'Hotel Izolace 3']) {
        const h = await createHotel(su, { name });
        hotels.push(h);
        orders.push(
          (await createOrder(su, h.code, [{ productCode: factory.kit.productCode, crates: 1 }]))
            .code,
        );
      }
    });
    afterAll(async () => {
      await t?.close();
      await su?.close();
    });

    for (const shape of ['one grant with two hotels', 'two grants (two payers)'] as const)
      it(`${shape}: exactly its hotels, each with its own orders; the third hotel is 404 everywhere`, async () => {
        const [h1, h2, h3] = hotels as [HotelDetail, HotelDetail, HotelDetail];
        const a = await account();
        if (shape === 'one grant with two hotels') await grant(a.user.id, [h1.id, h2.id]);
        else {
          await grant(a.user.id, [h1.id]);
          await grant(a.user.id, [h2.id]);
        }
        const b = await account();
        await grant(b.user.id, [h3.id]);

        const mine = (await get('hotels', a.session).expect(200)).body as PortalHotel[];
        expect(mine.map((h) => h.id).sort()).toEqual([h1.id, h2.id].sort());
        const d1 = (await get(`hotels/${h1.id}/deliveries`, a.session).expect(200))
          .body as PortalDeliveries;
        const d2 = (await get(`hotels/${h2.id}/deliveries`, a.session).expect(200))
          .body as PortalDeliveries;
        expect(orderCodes(d1)).toContain(orders[0]);
        expect(orderCodes(d1)).not.toContain(orders[1]);
        expect(orderCodes(d1)).not.toContain(orders[2]);
        expect(orderCodes(d2)).toContain(orders[1]);
        expect(orderCodes(d2)).not.toContain(orders[0]);
        for (const path of ['', '/profile', '/deliveries', '/contracts'])
          expect((await get(`hotels/${h3.id}${path}`, a.session)).status, `A ${path}`).toBe(404);
        // The other account: only its hotel; A's hotels are 404 for it.
        const theirs = (await get('hotels', b.session).expect(200)).body as PortalHotel[];
        expect(theirs.map((h) => h.id)).toEqual([h3.id]);
        for (const id of [h1.id, h2.id])
          for (const path of ['', '/profile', '/deliveries', '/contracts'])
            expect((await get(`hotels/${id}${path}`, b.session)).status, `B ${path}`).toBe(404);
      });

    it('revoking one hotel of a two-hotel account: gone at once from the list and every path; the other hotel stays', async () => {
      const [h1, h2] = hotels as [HotelDetail, HotelDetail];
      const a = await account();
      const g1 = await grant(a.user.id, [h1.id]);
      await grant(a.user.id, [h2.id]);
      expect(((await get('hotels', a.session).expect(200)).body as PortalHotel[]).length).toBe(2);
      await t.app.get(PortalGrantsService).revoke(adminId, g1.id, 'synthetic revocation');
      const left = (await get('hotels', a.session).expect(200)).body as PortalHotel[];
      expect(left.map((h) => h.id)).toEqual([h2.id]);
      for (const path of ['', '/profile', '/deliveries', '/contracts'])
        expect((await get(`hotels/${h1.id}${path}`, a.session)).status, path).toBe(404);
      await get(`hotels/${h2.id}/deliveries`, a.session).expect(200);
    });
  },
);
