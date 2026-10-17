import { randomUUID } from 'node:crypto';
import type { AdminUserDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { labelingKit, type LabelingKit } from './support/labeling-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Who may record weights and dimensions (doc 025 §7 / §13 B4): production supervisor, warehouse
 * supervisor and ADMIN (catalog:weights_record); everyone with catalog:read may read them. Real
 * sign-in; synthetic data only.
 */
describe.skipIf(!hasDatabase)('weights access (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let kit: LabelingKit;
  const as = (cookie: string) => ({
    get: (path: string) => request(ra.app.getHttpServer()).get(path).set('Cookie', cookie),
    post: (path: string, body: object) =>
      request(ra.app.getHttpServer()).post(path).set('Cookie', cookie).send(body),
  });
  const tare = () => ({
    requestId: randomUUID(),
    measuredOn: '2026-10-15',
    method: 'Plošinová váha',
    correctionOf: null,
    correctionReason: null,
    massG: '1850',
    configuration: 'S přepážkami',
  });

  async function user(roles: string[]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `w-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Vážení ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'weights access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cookie = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await as(cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    return cookie;
  }

  beforeAll(async () => {
    su = await createTestApp();
    ra = await createTestApp({}, {}, { auth: 'real' });
    kit = await labelingKit(su, { capacity: 2 });
    const u = await prepareInvitedUser(ra, {
      email: `w-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Weights Admin',
    });
    adminId = u.id;
    await ra.prisma.userRole.create({
      data: { userId: u.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, u.email);
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

  it('supervisors and ADMIN record; operators and catalogue readers only read', async () => {
    const path = `/api/admin/catalog/crate-types/${kit.crateTypeCode}`;
    for (const role of ['PRODUCTION_SUPERVISOR', 'WAREHOUSE_SUPERVISOR']) {
      const cookie = await user([role]);
      expect((await as(cookie).post(`${path}/tare`, tare())).status, role).toBe(201);
    }
    expect((await as(admin).post(`${path}/tare`, tare())).status).toBe(201);
    for (const role of ['PRODUCTION_OPERATOR', 'WAREHOUSE_OPERATOR']) {
      const cookie = await user([role]);
      expect((await as(cookie).post(`${path}/tare`, tare())).status, role).toBe(403);
    }
    const operator = await user(['PRODUCTION_OPERATOR']);
    const read = await as(operator).get(`${path}/measurements`);
    expect(read.status).toBe(200);
    expect(read.body.tare.history).toHaveLength(3);
    // A warehouse operator has no catalogue access at all.
    expect((await as(await user(['WAREHOUSE_OPERATOR'])).get(`${path}/measurements`)).status).toBe(
      403,
    );
  });
});
