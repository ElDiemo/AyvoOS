import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, CurrentUser, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * One atomic change of a user's access (doc 021 §7): roles, sites and narrower warehouses are
 * replaced together or not at all, with one reason, idempotent per request id, audited with the
 * previous and the new state — through the real guard, sessions and database.
 */
describe.skipIf(!hasDatabase)('user access editor', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  let de: SiteDetail;
  const http = () => request(t.app.getHttpServer());
  const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });

  async function createUser(roles: string[], siteIds: string[] = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: unique('access'),
      displayName: 'Access Test',
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'test setup',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as AdminUserDetail;
  }

  const update = (userId: string, body: Record<string, unknown>, cookie = admin) =>
    as(cookie).post(`/api/admin/identity/users/${userId}/access`, {
      requestId: randomUUID(),
      roles: [],
      siteIds: [],
      warehouseCodes: [],
      reason: 'access review',
      ...body,
    });

  /** Open assignments straight from the database. */
  const state = async (userId: string) => ({
    roles: (await t.prisma.userRole.findMany({ where: { userId, revokedAt: null } }))
      .map((r) => r.roleCode)
      .sort(),
    scopes: (
      await t.prisma.userScope.findMany({
        where: { userId, revokedAt: null },
        include: { location: true },
      })
    )
      .map((s) => (s.type === 'SITE' ? `SITE:${s.siteId}` : `WAREHOUSE:${s.location!.code}`))
      .sort(),
  });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('access-admin'),
      displayName: 'Access Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    const created = await as(admin).post('/api/admin/sites', {
      code: `DE-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Zugang Test',
      countryCode: 'DE',
      addressLine1: 'Musterstraße 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      timeZone: 'Europe/Berlin',
      defaultLocale: 'de-DE',
      defaultCurrency: 'EUR',
      capabilities: ['WAREHOUSE'],
      reason: 'access test site',
    });
    expect(created.status).toBe(201);
    de = created.body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${de.id}/warehouses`, {
        requestId: randomUUID(),
        code: `${de.code}-MAIN`,
        name: 'Hlavní sklad',
        reason: 'access test warehouse',
      })
      .expect(201);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('replaces roles, sites and warehouses together and audits before and after', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const requestId = randomUUID();
    const res = await update(user.id, {
      requestId,
      roles: ['WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID, de.id],
      warehouseCodes: [`${de.code}-MAIN`],
      reason: 'promoted, also covers Germany',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = res.body as AdminUserDetail;
    expect(after.roles.map((r) => r.code)).toEqual(['WAREHOUSE_SUPERVISOR']);
    expect(await state(user.id)).toEqual({
      roles: ['WAREHOUSE_SUPERVISOR'],
      scopes: [`SITE:${INITIAL_SITE_ID}`, `SITE:${de.id}`, `WAREHOUSE:${de.code}-MAIN`].sort(),
    });
    const summary = after.audit.find((a) => a.type === 'USER_ACCESS_UPDATED')!;
    expect(summary).toMatchObject({
      reason: 'promoted, also covers Germany',
      details: {
        requestId,
        before: { roles: ['WAREHOUSE_OPERATOR'], sites: ['CZ-PREROV-01'], warehouses: [] },
        after: {
          roles: ['WAREHOUSE_SUPERVISOR'],
          sites: ['CZ-PREROV-01', de.code].sort(),
          warehouses: [`${de.code}-MAIN`],
        },
        added: {
          roles: ['WAREHOUSE_SUPERVISOR'],
          sites: [de.code],
          warehouses: [`${de.code}-MAIN`],
        },
        removed: { roles: ['WAREHOUSE_OPERATOR'], sites: [], warehouses: [] },
      },
    });
    // The single changes are audited too, all with the same reason.
    const types = after.audit
      .filter((a) => a.reason === 'promoted, also covers Germany')
      .map((a) => a.type)
      .sort();
    expect(types).toEqual(
      [
        'ROLE_GRANTED',
        'ROLE_REVOKED',
        'SCOPE_GRANTED',
        'SCOPE_GRANTED',
        'USER_ACCESS_UPDATED',
      ].sort(),
    );

    // Removing a site removes its narrower warehouses in the same change.
    const back = await update(user.id, {
      roles: ['WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
    });
    expect(back.status).toBe(200);
    expect((await state(user.id)).scopes).toEqual([`SITE:${INITIAL_SITE_ID}`]);
  });

  it('is idempotent per request id, also for concurrent repeats', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const body = {
      requestId: randomUUID(),
      roles: ['WAREHOUSE_OPERATOR', 'PRODUCTION_OPERATOR'],
      siteIds: [INITIAL_SITE_ID],
    };
    const [a, b] = await Promise.all([update(user.id, body), update(user.id, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const replay = await update(user.id, body);
    expect(replay.status).toBe(200);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'USER_ACCESS_UPDATED', targetUserId: user.id },
      }),
    ).toBe(1);
    expect(
      await t.prisma.userRole.count({
        where: { userId: user.id, roleCode: 'PRODUCTION_OPERATOR', revokedAt: null },
      }),
    ).toBe(1);

    const other = await update(user.id, { ...body, reason: 'another reason' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a refused change leaves every assignment as it was', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const before = await state(user.id);
    const cases: [Record<string, unknown>, number, string][] = [
      // A valid addition together with a planned role: nothing of it is applied.
      [
        { roles: ['WAREHOUSE_SUPERVISOR', 'FINANCE'], siteIds: [INITIAL_SITE_ID, de.id] },
        422,
        'ROLE_NOT_AVAILABLE',
      ],
      // A warehouse of a site the user would not have.
      [
        {
          roles: ['WAREHOUSE_OPERATOR'],
          siteIds: [INITIAL_SITE_ID],
          warehouseCodes: [`${de.code}-MAIN`],
        },
        422,
        'SITE_ACCESS_REQUIRED',
      ],
      [{ roles: ['WAREHOUSE_OPERATOR'], siteIds: [randomUUID()] }, 422, 'UNKNOWN_SITE'],
      [
        { roles: ['WAREHOUSE_OPERATOR'], siteIds: [INITIAL_SITE_ID], warehouseCodes: ['NOPE'] },
        422,
        'UNKNOWN_WAREHOUSE',
      ],
      [{ roles: ['NO_SUCH_ROLE'], siteIds: [INITIAL_SITE_ID] }, 422, 'UNKNOWN_ROLE'],
      [{ roles: ['WAREHOUSE_OPERATOR'], siteIds: [INITIAL_SITE_ID] }, 422, 'NO_CHANGES'],
    ];
    for (const [body, status, code] of cases) {
      const res = await update(user.id, body);
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
      expect(await state(user.id)).toEqual(before);
    }
    for (const body of [
      { reason: '' },
      { reason: '  ' },
      { requestId: 'nope' },
      { roles: ['WAREHOUSE_OPERATOR', 'WAREHOUSE_OPERATOR'] },
    ]) {
      expect((await update(user.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await state(user.id)).toEqual(before);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'USER_ACCESS_UPDATED', targetUserId: user.id },
      }),
    ).toBe(0);
  });

  it('keeps an existing planned role when it stays, and can remove it, but never adds it', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'FINANCE', grantReason: 'assigned before the rule' },
    });
    const keep = await update(user.id, {
      roles: ['FINANCE', 'WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
    });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect((await state(user.id)).roles).toEqual(['FINANCE', 'WAREHOUSE_SUPERVISOR']);
    const drop = await update(user.id, {
      roles: ['WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
    });
    expect(drop.status).toBe(200);
    const readd = await update(user.id, {
      roles: ['FINANCE', 'WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
    });
    expect(readd.status).toBe(422);
    expect(readd.body.code).toBe('ROLE_NOT_AVAILABLE');
  });

  it('only identity:users_manage may change access; the change applies at once', async () => {
    const target = await createUser(['WAREHOUSE_OPERATOR']);
    const supervisor = await createUser(['WAREHOUSE_SUPERVISOR']);
    const cookie = await sessionCookie(t, supervisor.email);
    const forbidden = await update(
      target.id,
      { roles: ['ADMIN'], siteIds: [INITIAL_SITE_ID] },
      cookie,
    );
    expect(forbidden.status).toBe(403);
    const anonymous = await http().post(`/api/admin/identity/users/${target.id}/access`).send({
      requestId: randomUUID(),
      roles: [],
      siteIds: [],
      warehouseCodes: [],
      reason: 'x y z',
    });
    expect(anonymous.status).toBe(401);
    expect((await update(randomUUID(), { roles: [], siteIds: [] })).status).toBe(404);

    // The target signs in; adding the German site shows at once, removing it ends access at once.
    const targetCookie = await sessionCookie(t, target.email);
    await update(target.id, {
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: [INITIAL_SITE_ID, de.id],
    }).expect(200);
    let me = (await as(targetCookie).get('/api/auth/me')).body as CurrentUser;
    expect(me.sites.map((s) => s.id).sort()).toEqual([INITIAL_SITE_ID, de.id].sort());
    await update(target.id, { roles: ['WAREHOUSE_OPERATOR'], siteIds: [INITIAL_SITE_ID] }).expect(
      200,
    );
    me = (await as(targetCookie).get('/api/auth/me')).body as CurrentUser;
    expect(me.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);
    const forged = await as(targetCookie).post('/api/auth/active-site', { siteId: de.id });
    expect(forged.status).toBe(403);
  });

  it('an administrator removing ADMIN from a colleague keeps the last-admin protection path', async () => {
    // A second, temporary administrator loses ADMIN through the editor; the shared database may
    // hold other administrators, so the refusal of the very last one is covered by identity.e2e
    // through the same server path (removeRole → assertNotLastAdmin).
    const colleague = await createUser(['ADMIN']);
    const res = await update(colleague.id, {
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: [INITIAL_SITE_ID],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await state(colleague.id)).roles).toEqual(['WAREHOUSE_OPERATOR']);
  });
});
