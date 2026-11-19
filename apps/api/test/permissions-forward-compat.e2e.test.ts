import { randomUUID } from 'node:crypto';
import {
  currentUserSchema,
  PERMISSION_CODES,
  permissionCatalogSchema,
  roleDetailSchema,
  SECURITY_ADMIN_PERMISSIONS,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Rollback compatibility of permissions: a newer database may hold a permission code this version
 * does not know (an application rolled back after a migration added permissions). This version
 * still loads the signed-in user and the administration; the unknown code grants nothing here and
 * is never removed by a role edit made here. Real sign-in, a real catalogue row.
 */
const FUTURE = 'future:feature_x';
/** A newer code that ADMIN does NOT hold (only a custom role): nobody here may hand it out. */
const NOT_HELD = 'future:feature_y';

describe.skipIf(!hasDatabase)('permissions from a newer database (rollback compatibility)', () => {
  let t: TestApp;
  let admin: string;
  const http = () => request(t.app.getHttpServer());
  const role = `FUT_${randomUUID().slice(0, 6).toUpperCase()}`;
  const onlyFuture = `FUTO_${randomUUID().slice(0, 6).toUpperCase()}`;
  let roleId = '';
  /** The strong custom role of the non-admin test; its permissions are removed in afterAll. */
  const strong = `FUTS_${randomUUID().slice(0, 6).toUpperCase()}`;

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
      // Other files check that only ADMIN holds a permission: the strong role keeps none.
      await db.$executeRaw`DELETE FROM "role_permissions" WHERE "role_code" = ${strong}`;
      for (const code of [FUTURE, NOT_HELD]) {
        await db.$executeRaw`DELETE FROM "role_permissions" WHERE "permission_code" = ${code}`;
        await db.$executeRaw`DELETE FROM "permissions" WHERE "code" = ${code}`;
      }
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
  /** Creates a user through the API as the administrator (roles granted on creation). */
  const createUser = (roles: string[], siteIds: string[] = [INITIAL_SITE_ID]) =>
    http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({
        email: `fut-u-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: 'Uživatel (budoucí oprávnění)',
        roles,
        siteIds,
        warehouseCodes: [],
        reason: 'test',
      });
  const openGrants = (userId: string, roleCode: string) =>
    t.prisma.userRole.count({ where: { userId, roleCode, revokedAt: null } });

  // Rollback after a migration that granted ADMIN a new permission (doc 069 2a, #196): the
  // administrator holds the code in the database, so ADMIN and roles with it stay assignable.
  it('an administrator still assigns ADMIN and a role with the newer code: both held in the database', async () => {
    const created = await createUser(['ADMIN'], []);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await openGrants(created.body.id, 'ADMIN')).toBe(1);

    const colleague = await createUser([role]);
    expect(colleague.status, JSON.stringify(colleague.body)).toBe(201);
    const granted = await http()
      .post(`/api/admin/identity/users/${colleague.body.id}/roles/grant`)
      .set('Cookie', admin)
      .send({ role: 'ADMIN', reason: 'zástup správce' });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(await openGrants(colleague.body.id, 'ADMIN')).toBe(1);
    // …and takes it back (the last-admin protection path is not involved: several admins).
    await http()
      .post(`/api/admin/identity/users/${colleague.body.id}/roles/revoke`)
      .set('Cookie', admin)
      .send({ role: 'ADMIN', reason: 'zástup skončil' })
      .expect(200);
    expect(await openGrants(colleague.body.id, 'ADMIN')).toBe(0);
  });

  it('a newer code the administrator does not hold is never handed out (not skipped as unknown)', async () => {
    const other = `FUTN_${randomUUID().slice(0, 6).toUpperCase()}`;
    await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code: other,
        name: 'S kódem, který správce nemá',
        description: '',
        permissions: ['inventory:read'],
        copiedFrom: null,
        reason: 'test vlastní role',
      })
      .expect(201);
    await asMigration(async (db) => {
      await db.$executeRaw`INSERT INTO "permissions" ("code", "description", "warehouse_scoped", "security_admin", "site_scoped", "site_capability")
        VALUES (${NOT_HELD}, 'A newer permission ADMIN does not hold', false, false, false, NULL)`;
      await db.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES (${other}, ${NOT_HELD})`;
    });
    const refused = await createUser([other]);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('PRIVILEGE_ESCALATION');
    expect(refused.body.message).toContain(NOT_HELD);
    expect(refused.body.message).not.toContain(FUTURE);

    const user = await createUser([]);
    expect(user.status, JSON.stringify(user.body)).toBe(201);
    const grant = await http()
      .post(`/api/admin/identity/users/${user.body.id}/roles/grant`)
      .set('Cookie', admin)
      .send({ role: other, reason: 'nesmí projít' });
    expect(grant.status).toBe(403);
    expect(grant.body.code).toBe('PRIVILEGE_ESCALATION');
    expect(await openGrants(user.body.id, other)).toBe(0);
  });

  it('an ordinary non-administrator can grant nothing — neither ADMIN nor a role with the newer code', async () => {
    // The strongest custom role there is: every non-security permission this version knows
    // (custom roles never hold security administration — the database refuses it).
    const everything = PERMISSION_CODES.filter(
      (p) => !SECURITY_ADMIN_PERMISSIONS.includes(p) && !p.startsWith('portal:'),
    );
    const made = await http().post('/api/admin/identity/roles').set('Cookie', admin).send({
      code: strong,
      name: 'Vše kromě správy zabezpečení',
      description: '',
      permissions: everything,
      copiedFrom: null,
      reason: 'test vlastní role',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const account = await prepareInvitedUser(t, {
      email: `fut-strong-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Silný neadmin',
    });
    await t.prisma.userRole.create({
      data: { userId: account.id, roleCode: strong, grantReason: 'test' },
    });
    const cookie = await sessionCookie(t, account.email);
    const target = await createUser([]);
    expect(target.status).toBe(201);
    const as = (path: string, body: object) => http().post(path).set('Cookie', cookie).send(body);

    for (const [path, body] of [
      [
        `/api/admin/identity/users/${account.id}/roles/grant`,
        { role: 'ADMIN', reason: 'sám sobě' },
      ],
      [`/api/admin/identity/users/${target.body.id}/roles/grant`, { role: 'ADMIN', reason: 'x' }],
      [`/api/admin/identity/users/${target.body.id}/roles/grant`, { role, reason: 'x' }],
      [
        '/api/admin/identity/users',
        {
          email: `fut-x-${randomUUID().slice(0, 8)}@ayvo.test`,
          displayName: 'x',
          roles: ['ADMIN'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'x',
        },
      ],
      [
        '/api/admin/identity/roles',
        {
          code: `FUTX_${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'x',
          description: '',
          permissions: ['identity:users_manage'],
          copiedFrom: null,
          reason: 'x',
        },
      ],
    ] as const) {
      const res = await as(path, body);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(await openGrants(account.id, 'ADMIN')).toBe(0);
    expect(await openGrants(target.body.id, 'ADMIN')).toBe(0);
    expect(await openGrants(target.body.id, role)).toBe(0);
    // Even a migration cannot put security administration into a custom role.
    await expect(
      asMigration(async (db) => {
        await db.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES (${strong}, 'identity:users_manage')`;
      }),
    ).rejects.toThrow(/security-administration/);
  });
});
