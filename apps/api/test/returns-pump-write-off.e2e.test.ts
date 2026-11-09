import { randomUUID } from 'node:crypto';
import type { SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETURN_ENV, returnsApi } from './support/return-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * "Odepsat pumpičky" (doc 047 §6.2, step P — UI only): the existing RETURN_PUMP_COUNT takes one
 * count X. One row per request id, a retry is the same row, a negative count needs a reason,
 * never a stock movement, and another site's receipt is not found.
 */
describe.skipIf(!hasDatabase)('return intake: pump write-off of X', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  const rows = (receiptId: string) =>
    t.prisma.returnPumpCount.findMany({ where: { receiptId }, orderBy: { defective: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('X = 5 is one row; a retry with the same id is the same row; no ledger row', async () => {
    const api = returnsApi(t);
    const receipt = await api.open();
    const id = (await t.prisma.returnReceipt.findUniqueOrThrow({ where: { code: receipt.code } }))
      .id;
    const movements = await t.prisma.inventoryMovement.count();
    const requestId = randomUUID();
    const post = (body: object) =>
      http().post(`/api/admin/returns/receipts/${receipt.code}/pumps`).send(body);
    const first = await post({ requestId, defective: 5, reason: null });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.defectivePumps).toBe(5);
    // Another entry meanwhile, then the retry of the first: still one row of 5.
    await post({ requestId: randomUUID(), defective: 2, reason: null }).expect(200);
    const again = await post({ requestId, defective: 5, reason: null });
    expect(again.status).toBe(200);
    expect((await rows(id)).map((r) => r.defective)).toEqual([2, 5]);
    // The same id with another count is refused (never a second meaning).
    expect((await post({ requestId, defective: 6, reason: null })).status).toBe(409);
    // A correction needs a reason.
    expect((await post({ requestId: randomUUID(), defective: -1, reason: null })).status).toBe(400);
    await post({ requestId: randomUUID(), defective: -1, reason: 'přepočítáno' }).expect(200);
    expect((await api.detail(receipt.code)).defectivePumps).toBe(6);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
  });

  it("another site's receipt is not found, also for a replay (real sign-in)", async () => {
    const ra = await createTestApp(RETURN_ENV, {}, { auth: 'real' });
    let adminId = '';
    try {
      const user = await prepareInvitedUser(ra, {
        email: `pumps-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: 'Pumps Admin',
      });
      adminId = user.id;
      await ra.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
      });
      const cookie = await sessionCookie(ra, user.email);
      const as = () => request(ra.app.getHttpServer());
      const post = (path: string, body: object) =>
        as()
          .post(path)
          .set('Cookie', cookie)
          .send({ requestId: randomUUID(), ...body });
      await as()
        .post('/api/auth/active-site')
        .set('Cookie', cookie)
        .send({ siteId: INITIAL_SITE_ID })
        .expect(200);
      const receipt = (await post('/api/admin/returns/receipts', { hotelCode: null }).expect(201))
        .body as { code: string };
      const requestId = randomUUID();
      await as()
        .post(`/api/admin/returns/receipts/${receipt.code}/pumps`)
        .set('Cookie', cookie)
        .send({ requestId, defective: 3, reason: null })
        .expect(200);
      const other = (
        await post('/api/admin/sites', {
          code: `PW-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Druhá provozovna (pumpičky)',
          countryCode: 'SK',
          addressLine1: 'Testovacia 4',
          addressLine2: null,
          postalCode: '811 04',
          city: 'Bratislava',
          timeZone: 'Europe/Bratislava',
          defaultLocale: 'sk-SK',
          defaultCurrency: 'EUR',
          capabilities: ['WAREHOUSE', 'PRODUCTION'],
          reason: 'second site',
        }).expect(201)
      ).body as SiteDetail;
      await post(`/api/admin/sites/${other.id}/warehouses`, {
        code: `${other.code}-W`,
        name: 'Sklad',
        reason: 'first warehouse',
      }).expect(201);
      await as()
        .post('/api/auth/active-site')
        .set('Cookie', cookie)
        .send({ siteId: other.id })
        .expect(200);
      for (const id of [requestId, randomUUID()]) {
        await as()
          .post(`/api/admin/returns/receipts/${receipt.code}/pumps`)
          .set('Cookie', cookie)
          .send({ requestId: id, defective: 3, reason: null })
          .expect(404);
      }
      const receiptId = (
        await ra.prisma.returnReceipt.findUniqueOrThrow({ where: { code: receipt.code } })
      ).id;
      expect(await ra.prisma.returnPumpCount.count({ where: { receiptId } })).toBe(1);
    } finally {
      await ra.prisma.userRole.updateMany({
        where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'end of test' },
      });
      await ra.close();
    }
  });
});
