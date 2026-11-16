import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, CommissionTerms, CommissionTermsOverviewRow } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Sales commissions PR 1a — commission terms per salesperson (doc 068 §3.1, §4.1, §8.1; ADR 0046
 * §2a; PROTOTYPE). Real sign-in: an ADMIN and two salespeople with the SALES role only. Only ADMIN
 * manages terms — never a salesperson, never a custom role; versions are append-only and
 * serialised; rates are refused, never rounded.
 */
describe.skipIf(!hasDatabase)('commission terms (Obchod → Provize → Nastavení)', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b', { id: string; cookie: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const PATH = '/api/admin/sales/commission-terms';
  const terms = (salespersonId: string, extra: object = {}) => ({
    requestId: randomUUID(),
    salespersonId,
    expectedVersion: 0,
    initialRate: '20.00',
    initialMonths: 24,
    maintenanceRate: '5.00',
    reason: 'smlouva o obchodní spolupráci',
    confirm: true,
    ...extra,
  });
  const post = (cookie: string, body: object) => http().post(PATH).set('Cookie', cookie).send(body);
  const get = (cookie: string, path = '') => http().get(`${PATH}${path}`).set('Cookie', cookie);

  async function createUser(roles: string[], displayName: string) {
    const email = unique('ct');
    const created = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({ email, displayName, roles, siteIds: [], warehouseCodes: [], reason: 'commissions' })
      .expect(201);
    return { id: (created.body as AdminUserDetail).id, cookie: await sessionCookie(t, email) };
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: unique('ct-admin'),
      displayName: 'Admin Provizí',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    people.a = await createUser(['SALES'], 'Alena Fiktivní');
    people.b = await createUser(['SALES'], 'Bohdan Smyšlený');
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('the permission is ADMIN-only security administration in the catalogue', async () => {
    const catalogue = (
      await http().get('/api/admin/identity/permissions').set('Cookie', admin).expect(200)
    ).body as { code: string; securityAdmin: boolean }[];
    expect(catalogue.find((p) => p.code === 'sales:commission_terms_manage')).toMatchObject({
      securityAdmin: true,
    });
    const holders = await t.prisma.rolePermission.findMany({
      where: { permissionCode: 'sales:commission_terms_manage' },
    });
    expect(holders.map((h) => h.roleCode)).toEqual(['ADMIN']);
  });

  it('two salespeople with different terms; each reads only their own', async () => {
    const a = await post(admin, terms(people.a.id));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await post(
      admin,
      terms(people.b.id, { initialRate: '10', initialMonths: 36, maintenanceRate: '3' }),
    );
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((b.body as CommissionTerms).valid).toMatchObject({
      version: 1,
      initialRate: '10.00',
      initialMonths: 36,
      maintenanceRate: '3.00',
      recordedByName: 'Admin Provizí',
    });

    const mineA = (await get(people.a.cookie, '/mine').expect(200)).body as CommissionTerms;
    expect(mineA.salesperson.id).toBe(people.a.id);
    expect(mineA.valid).toMatchObject({ initialRate: '20.00', initialMonths: 24 });
    expect(mineA.history).toHaveLength(1);
    const mineB = (await get(people.b.cookie, '/mine').expect(200)).body as CommissionTerms;
    expect(mineB.valid).toMatchObject({ initialRate: '10.00', maintenanceRate: '3.00' });

    const overview = (await get(admin).expect(200)).body as CommissionTermsOverviewRow[];
    const row = (id: string) => overview.find((r) => r.salesperson.id === id);
    expect(row(people.a.id)?.valid?.initialRate).toBe('20.00');
    expect(row(people.b.id)?.valid?.initialRate).toBe('10.00');
  });

  it('a salesperson cannot record or read others’ terms (403); no edit route exists', async () => {
    const own = await post(people.a.cookie, terms(people.a.id, { expectedVersion: 1 }));
    expect(own.status).toBe(403);
    await post(people.a.cookie, terms(people.b.id, { expectedVersion: 1 })).expect(403);
    await get(people.a.cookie).expect(403);
    await get(people.a.cookie, `?salesperson=${people.b.id}`).expect(403);
    for (const method of ['put', 'patch', 'delete'] as const) {
      const res = await http()[method](PATH).set('Cookie', admin).send({});
      expect(res.status, method).toBe(404);
    }
    // Nothing was written by the refused calls.
    expect(
      await t.prisma.salesCommissionTerms.count({ where: { salespersonId: people.a.id } }),
    ).toBe(1);
  });

  it('a custom role can never hold the permission (API and database)', async () => {
    const code = `TERMS_${randomUUID().slice(0, 4).toUpperCase()}`;
    const res = await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code,
        name: 'Vedoucí provizí',
        description: '',
        permissions: ['sales:work', 'sales:commission_terms_manage'],
        reason: 'attempt',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SECURITY_PERMISSION_RESERVED');

    // Directly in the database (as a superuser): the trigger refuses it too.
    await expect(
      withPrivileged(async (db) => {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "roles" ("code", "name", "description", "is_system", "active")
                               VALUES (${code}, 'X', '', false, true)`;
          await tx.$executeRaw`INSERT INTO "role_permissions" ("role_code", "permission_code")
                               VALUES (${code}, 'sales:commission_terms_manage')`;
        });
      }),
    ).rejects.toThrow(/custom role cannot hold a security-administration permission/);
  });

  it('a salesperson with a custom role holding sales:manage is still refused', async () => {
    const code = `MGR_${randomUUID().slice(0, 4).toUpperCase()}`;
    await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', admin)
      .send({
        code,
        name: 'Vedoucí obchodu',
        description: '',
        permissions: ['sales:work', 'sales:manage'],
        reason: 'sales lead',
      })
      .expect(201);
    const lead = await createUser(['SALES', code], 'Vedoucí Obchodu');
    await post(lead.cookie, terms(lead.id)).expect(403);
    await get(lead.cookie).expect(403);
    await get(lead.cookie, '/mine').expect(200);
  });

  it('values are refused, never rounded; 0.00 is an explicit rate', async () => {
    const cases: [object, string][] = [
      [{ initialRate: '100.01' }, 'TERMS_RATE_INVALID'],
      [{ initialRate: '-1' }, 'TERMS_RATE_INVALID'],
      [{ initialRate: '20.005' }, 'TERMS_RATE_INVALID'],
      [{ maintenanceRate: '5.555' }, 'TERMS_RATE_INVALID'],
      [{ initialMonths: 0 }, 'TERMS_MONTHS_INVALID'],
      [{ initialMonths: 1.5 }, 'TERMS_MONTHS_INVALID'],
    ];
    for (const [extra, code] of cases) {
      const res = await post(admin, terms(people.a.id, { expectedVersion: 1, ...extra }));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.code).toBe(code);
    }
    expect(
      await t.prisma.salesCommissionTerms.count({ where: { salespersonId: people.a.id } }),
    ).toBe(1);

    // The database holds the same rule, even for a privileged writer.
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`INSERT INTO "sales_commission_terms"
          ("salesperson_id", "version", "initial_rate", "initial_months", "maintenance_rate", "reason", "recorded_by", "request_id")
          VALUES (${people.a.id}::uuid, 2, 20.005, 24, 5, 'x', ${adminId}::uuid, ${randomUUID()}::uuid)`,
      ),
    ).rejects.toThrow(/initial_rate_check/);
  });

  it('history: version 2 leaves version 1 intact, is refused for a stale version, and replays', async () => {
    const before = await t.prisma.salesCommissionTerms.findFirstOrThrow({
      where: { salespersonId: people.a.id, version: 1 },
    });
    const body = terms(people.a.id, {
      expectedVersion: 1,
      initialRate: '0',
      maintenanceRate: '5,5',
      reason: 'nová smlouva od ledna',
    });
    const v2 = await post(admin, body);
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    const view = v2.body as CommissionTerms;
    expect(view.valid).toMatchObject({ version: 2, initialRate: '0.00', maintenanceRate: '5.50' });
    expect(view.history.map((h) => h.version)).toEqual([2, 1]);
    const after = await t.prisma.salesCommissionTerms.findFirstOrThrow({
      where: { salespersonId: people.a.id, version: 1 },
    });
    expect(after).toEqual(before);

    // The same request again → the same result, nothing new.
    const replay = await post(admin, body);
    expect(replay.status).toBe(201);
    expect(
      await t.prisma.salesCommissionTerms.count({ where: { salespersonId: people.a.id } }),
    ).toBe(2);
    // The same request id with another payload → conflict.
    const other = await post(admin, { ...body, reason: 'jiný důvod' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_CONFLICT');
    // A stale version → 409 CONCURRENT_CHANGE.
    const stale = await post(admin, terms(people.a.id, { expectedVersion: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONCURRENT_CHANGE');
  });

  it('the database refuses UPDATE, DELETE and TRUNCATE of terms, and a version gap', async () => {
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`UPDATE "sales_commission_terms" SET "initial_rate" = 99 WHERE "salesperson_id" = ${people.a.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`DELETE FROM "sales_commission_terms" WHERE "salesperson_id" = ${people.a.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      withPrivileged((db) => db.$executeRaw`TRUNCATE "sales_commission_terms"`),
    ).rejects.toThrow();
    await expect(
      withPrivileged(
        (db) =>
          db.$executeRaw`INSERT INTO "sales_commission_terms"
          ("salesperson_id", "version", "initial_rate", "initial_months", "maintenance_rate", "reason", "recorded_by", "request_id")
          VALUES (${people.a.id}::uuid, 9, 20, 24, 5, 'gap', ${adminId}::uuid, ${randomUUID()}::uuid)`,
      ),
    ).rejects.toThrow(/follow each other/);
    expect(
      await t.prisma.salesCommissionTerms.count({ where: { salespersonId: people.a.id } }),
    ).toBe(2);
  });

  it('two concurrent versions from the same version: one 201, one 409', async () => {
    const results = await Promise.all([
      post(admin, terms(people.b.id, { expectedVersion: 1, initialRate: '11' })),
      post(admin, terms(people.b.id, { expectedVersion: 1, initialRate: '12' })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('CONCURRENT_CHANGE');
    const rows = await t.prisma.salesCommissionTerms.findMany({
      where: { salespersonId: people.b.id },
      orderBy: { version: 'asc' },
    });
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it('only an active user with sales:work can get terms', async () => {
    const plain = await prepareInvitedUser(t, {
      email: unique('ct-plain'),
      displayName: 'Bez obchodu',
    });
    const res = await post(admin, terms(plain.id));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SALESPERSON_NOT_ELIGIBLE');
    await get(admin, `?salesperson=${plain.id}`).expect(404);
    // A salesperson without any terms: valid = null ("Chybí podmínky provize").
    const fresh = await createUser(['SALES'], 'Cyril Vymyšlený');
    const mine = (await get(fresh.cookie, '/mine').expect(200)).body as CommissionTerms;
    expect(mine).toMatchObject({ valid: null, history: [] });
  });
});
