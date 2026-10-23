import { randomUUID } from 'node:crypto';
import {
  PLANNED_SYSTEM_ROLE_CODES,
  type AdminUserDetail,
  type RoleCatalog,
  type RoleDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Planned system roles (doc 021 §4c): FINANCE and HOTEL_USER are templates of modules that
 * do not exist yet (SALES is assignable since Obchod, doc 034). Every server-side assignment path refuses them, whatever the client sends;
 * active system roles and custom roles stay assignable; an assignment that already exists is kept
 * and can be revoked; the role records and their permission templates are unchanged.
 */
describe.skipIf(!hasDatabase)('planned system roles', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  const http = () => request(t.app.getHttpServer());
  const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const post = (path: string, body: object) => http().post(path).set('Cookie', admin).send(body);
  const createUser = (roles: string[], email = unique('user')) =>
    post('/api/admin/identity/users', {
      email,
      displayName: 'Planned Role Test',
      roles,
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'planned role test',
    });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('roles-admin'),
      displayName: 'Roles Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it.each(PLANNED_SYSTEM_ROLE_CODES)(
    '%s is refused at user creation — alone or with other roles — and nothing is created',
    async (role) => {
      for (const roles of [[role], ['WAREHOUSE_OPERATOR', role]]) {
        const email = unique('planned');
        const res = await createUser(roles, email);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.code).toBe('ROLE_NOT_AVAILABLE');
        // All-or-nothing: no user, no invitation, no audit of a creation.
        expect(await t.prisma.user.findUnique({ where: { email } })).toBeNull();
        expect(await t.prisma.userInvitation.count({ where: { email } })).toBe(0);
      }
    },
  );

  it.each(PLANNED_SYSTEM_ROLE_CODES)(
    '%s is refused by a direct role grant to an existing user',
    async (role) => {
      const created = await createUser(['WAREHOUSE_OPERATOR']);
      expect(created.status).toBe(201);
      const user = created.body as AdminUserDetail;
      const res = await post(`/api/admin/identity/users/${user.id}/roles/grant`, {
        role,
        reason: 'direct API call',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.code).toBe('ROLE_NOT_AVAILABLE');
      expect(await t.prisma.userRole.count({ where: { userId: user.id, roleCode: role } })).toBe(0);
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'ROLE_GRANTED', targetUserId: user.id, payload: { equals: { role } } },
        }),
      ).toBe(0);
    },
  );

  it('active system roles and custom roles stay assignable at creation and by grant', async () => {
    for (const role of [
      'WAREHOUSE_OPERATOR',
      'WAREHOUSE_SUPERVISOR',
      'PRODUCTION_OPERATOR',
      'PRODUCTION_SUPERVISOR',
      'SALES',
    ]) {
      const res = await createUser([role]);
      expect(res.status, role).toBe(201);
      expect((res.body as AdminUserDetail).roles.map((r) => r.code)).toEqual([role]);
    }

    const code = `PLAN_${randomUUID().slice(0, 4).toUpperCase()}`;
    const custom = await post('/api/admin/identity/roles', {
      code,
      name: 'Plánovač zásob',
      description: 'Stock summary only',
      permissions: ['inventory:stock_summary'],
      copiedFrom: null,
      reason: 'custom role from a planned template',
    });
    expect(custom.status, JSON.stringify(custom.body)).toBe(201);
    const withCustom = await createUser([code]);
    expect(withCustom.status).toBe(201);

    // ADMIN by grant (revoked again so no extra administrator remains).
    const base = (await createUser(['WAREHOUSE_OPERATOR'])).body as AdminUserDetail;
    for (const role of [code, 'ADMIN']) {
      const res = await post(`/api/admin/identity/users/${base.id}/roles/grant`, {
        role,
        reason: 'grant test',
      });
      expect(res.status, role).toBe(200);
    }
    await post(`/api/admin/identity/users/${base.id}/roles/revoke`, {
      role: 'ADMIN',
      reason: 'end of grant test',
    }).expect(200);
  });

  it('an existing assignment is kept and revocable, but cannot be added again', async () => {
    const user = (await createUser(['WAREHOUSE_OPERATOR'])).body as AdminUserDetail;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'FINANCE', grantReason: 'assigned before the rule' },
    });
    const detail = (
      await http().get(`/api/admin/identity/users/${user.id}`).set('Cookie', admin).expect(200)
    ).body as AdminUserDetail;
    expect(detail.roles.map((r) => r.code).sort()).toEqual(['FINANCE', 'WAREHOUSE_OPERATOR']);
    expect(detail.effectiveAccess.permissions).toContain('procurement:cost_write');

    await post(`/api/admin/identity/users/${user.id}/roles/revoke`, {
      role: 'FINANCE',
      reason: 'planned role removed',
    }).expect(200);
    const again = await post(`/api/admin/identity/users/${user.id}/roles/grant`, {
      role: 'FINANCE',
      reason: 'try to add it back',
    });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('ROLE_NOT_AVAILABLE');
  });

  it('the planned roles keep their records and permission templates', async () => {
    const roles = (await http().get('/api/admin/identity/roles').set('Cookie', admin).expect(200))
      .body as RoleCatalog;
    const byCode = Object.fromEntries(roles.map((r) => [r.code, r]));
    for (const code of PLANNED_SYSTEM_ROLE_CODES) {
      expect(byCode[code], code).toMatchObject({ code, system: true, active: true });
    }
    // SALES is the Obchod role now (doc 034): its planning stock permission was removed.
    expect(byCode.SALES!.permissions).toEqual(['sales:work']);
    expect(byCode.HOTEL_USER!.permissions).toEqual([]);
    expect(byCode.FINANCE!.permissions).toContain('procurement:cost_write');
    const detail = (
      await http()
        .get(`/api/admin/identity/roles/${byCode.HOTEL_USER!.id}`)
        .set('Cookie', admin)
        .expect(200)
    ).body as RoleDetail;
    expect(detail.code).toBe('HOTEL_USER');
  });
});
