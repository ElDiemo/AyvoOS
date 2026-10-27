import { randomUUID } from 'node:crypto';
import { currentUserSchema, roleDetailSchema, permissionCatalogSchema } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Rollback compatibility of permissions: a newer database may hold a permission code this version
 * does not know (an application rolled back after a migration added permissions). This version
 * still loads the signed-in user and the administration; the unknown code grants nothing here and
 * is never removed by a role edit made here. Real sign-in, a real catalogue row.
 */
const FUTURE = 'future:feature_x';

describe.skipIf(!hasDatabase)('permissions from a newer database (rollback compatibility)', () => {
  let t: TestApp;
  let admin: string;
  const http = () => request(t.app.getHttpServer());
  const role = `FUT_${randomUUID().slice(0, 6).toUpperCase()}`;
  const onlyFuture = `FUTO_${randomUUID().slice(0, 6).toUpperCase()}`;
  let roleId = '';

  /** A catalogue change only works inside the migration flag (as a migration would do it). */
  const asMigration = (
    sql: (db: Parameters<Parameters<typeof withPrivileged>[0]>[0]) => Promise<unknown>,
  ) =>
    withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('ayvo.catalogue_migration', 'on', true)`;
        await sql(tx as never);
      }),
    );

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: `fut-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Admin (budoucí oprávnění)',
    });
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    // A newer migration added a permission, granted it to ADMIN and to a custom role.
    await asMigration(async (db) => {
      await db.$executeRaw`INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability")
        VALUES (${FUTURE}, 'A permission of a newer version', false, false, false, NULL)`;
      await db.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES ('ADMIN', ${FUTURE})`;
    });
    const created = await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code: role,
        name: 'Sklad (s budoucím oprávněním)',
        description: '',
        permissions: ['inventory:read'],
        copiedFrom: null,
        reason: 'test vlastní role',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    roleId = created.body.id;
    await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code: onlyFuture,
        name: 'Jen budoucí oprávnění',
        description: '',
        permissions: [],
        copiedFrom: null,
        reason: 'test vlastní role',
      })
      .expect(201);
    await asMigration(async (db) => {
      await db.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES (${role}, ${FUTURE}), (${onlyFuture}, ${FUTURE})`;
    });
  });

  afterAll(async () => {
    // Leave the shared test database as it was (other files compare the catalogue).
    await asMigration(async (db) => {
      await db.$executeRaw`DELETE FROM "role_permissions" WHERE "permission_code" = ${FUTURE}`;
      await db.$executeRaw`DELETE FROM "permissions" WHERE "code" = ${FUTURE}`;
    }).catch(() => undefined);
    await t?.close();
  });

  it('the signed-in user loads; the unknown code is not reported and grants nothing', async () => {
    const me = await http().get('/api/auth/me').set('Cookie', admin).expect(200);
    const parsed = currentUserSchema.parse(me.body);
    expect(parsed.permissions).not.toContain(FUTURE);
    expect(parsed.permissions).toContain('identity:roles_manage');
    // A user whose only permission is the unknown one may do nothing.
    const user = await prepareInvitedUser(t, {
      email: `fut-only-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Jen budoucí',
    });
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: onlyFuture, grantReason: 'test' },
    });
    const cookie = await sessionCookie(t, user.email);
    const own = currentUserSchema.parse(
      (await http().get('/api/auth/me').set('Cookie', cookie).expect(200)).body,
    );
    expect(own.permissions).toEqual([]);
    for (const path of [
      '/api/admin/inventory/items',
      '/api/admin/identity/roles',
      '/api/admin/hotels',
    ])
      expect((await http().get(path).set('Cookie', cookie)).status, path).toBe(403);
  });

  it('the administration loads: the catalogue leaves the code out; a role edit here never removes it', async () => {
    const catalogue = permissionCatalogSchema.parse(
      (await http().get('/api/admin/identity/permissions').set('Cookie', admin).expect(200)).body,
    );
    expect(catalogue.map((p) => p.code)).not.toContain(FUTURE);
    const before = roleDetailSchema.parse(
      (await http().get(`/api/admin/identity/roles/${roleId}`).set('Cookie', admin).expect(200))
        .body,
    );
    expect(before.permissions).toEqual(['inventory:read']);
    // Edited here (without the code it cannot show): the code stays in the database.
    await http()
      .post(`/api/admin/identity/roles/${roleId}`)
      .set('Cookie', admin)
      .send({
        name: before.name,
        description: before.description,
        permissions: ['inventory:read', 'inventory:receive'],
        reason: 'úprava ve starší verzi',
      })
      .expect(200);
    const rows = await t.prisma.rolePermission.findMany({
      where: { roleCode: role },
      select: { permissionCode: true },
      orderBy: { permissionCode: 'asc' },
    });
    expect(rows.map((r) => r.permissionCode)).toEqual([
      FUTURE,
      'inventory:read',
      'inventory:receive',
    ]);
    // Removing a known one still works and still keeps the unknown one.
    await http()
      .post(`/api/admin/identity/roles/${roleId}`)
      .set('Cookie', admin)
      .send({
        name: before.name,
        description: before.description,
        permissions: ['inventory:read'],
        reason: 'úprava ve starší verzi',
      })
      .expect(200);
    expect(
      (await t.prisma.rolePermission.findMany({ where: { roleCode: role } }))
        .map((r) => r.permissionCode)
        .sort(),
    ).toEqual([FUTURE, 'inventory:read']);
  });
});
