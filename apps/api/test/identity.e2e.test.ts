import type { AdminUserDetail, CurrentUser, RoleCode } from '@ayvo/types';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_METADATA, type AccessRule } from '../src/identity/access.decorators.js';
import { bootstrapFirstAdmin } from '../src/identity/bootstrap.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

/**
 * Identity and access (Milestone 2C, ADR 0022, doc 021) against the real migrated database, the
 * real global guard, real sessions and the fake identity provider (APP_ENV=test only).
 */
describe.skipIf(!hasDatabase)('identity and access', () => {
  let t: TestApp;
  let adminCookie: string;
  const http = () => request(t.app.getHttpServer());
  const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 8)}@ayvo.test`;

  const cookieFrom = (res: Response, name: string): string | null => {
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const hit = raw.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0]!.slice(name.length + 1) : null;
  };

  /** The full browser flow: /auth/login → provider → /auth/callback. Returns the callback response. */
  async function signIn(email: string, next = '/warehouse'): Promise<Response> {
    const start = await http()
      .get('/api/auth/login')
      .query({ next, login_hint: email })
      .expect(302);
    const binding = cookieFrom(start, 'ayvo_login');
    expect(binding).toBeTruthy();
    const authorize = new URL(start.headers.location!);
    expect(authorize.origin).toBe(TEST_APP_ORIGIN);
    const provider = await http()
      .get(authorize.pathname + authorize.search)
      .expect(302);
    const callback = new URL(provider.headers.location!);
    return http()
      .get(callback.pathname + callback.search)
      .set('Cookie', `ayvo_login=${binding}`);
  }

  async function session(email: string): Promise<string> {
    const res = await signIn(email);
    expect(res.status).toBe(302);
    const token = cookieFrom(res, 'ayvo_session');
    expect(token).toBeTruthy();
    return `ayvo_session=${token}`;
  }

  async function createUser(roles: RoleCode[], warehouses: string[] = ['MAIN']) {
    const res = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', adminCookie)
      .send({
        email: unique('user'),
        displayName: 'Test User',
        roles,
        warehouseCodes: warehouses,
        reason: 'test setup',
      })
      .expect(201);
    return res.body as AdminUserDetail;
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const result = await bootstrapFirstAdmin(t.prisma, {
      email: 'owner@ayvo.test',
      displayName: 'Owner',
    });
    expect(result).toMatchObject({ ok: true });
    adminCookie = await session('owner@ayvo.test');
  });
  afterAll(() => t?.close());

  it('every route declares its access rule; only the passport, health and sign-in are public', async () => {
    const routes: { route: string; method: string; rule?: AccessRule }[] = [];
    for (const module of t.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as unknown as {
          prototype: Record<string, unknown>;
        } & object;
        const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = controller.prototype[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          if (path === undefined) continue;
          const method =
            (Reflect.getMetadata(METHOD_METADATA, handler) as number) === 1 ? 'POST' : 'GET';
          routes.push({
            route: `/api/${[base, path].filter((p) => p && p !== '/').join('/')}`,
            method,
            rule:
              (Reflect.getMetadata(ACCESS_METADATA, handler) as AccessRule | undefined) ??
              (Reflect.getMetadata(ACCESS_METADATA, controller) as AccessRule | undefined),
          });
        }
      }
    }
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.filter((r) => !r.rule)).toEqual([]);
    expect(
      routes
        .filter((r) => r.rule!.kind === 'public')
        .map((r) => `${r.method} ${r.route}`)
        .sort(),
    ).toEqual([
      'GET /api/auth/callback',
      'GET /api/auth/login',
      'GET /api/auth/test-provider/authorize',
      'GET /api/health',
      'GET /api/public/bottles/:token',
    ]);
    // Without a session every other route answers 401 — guards run before any parameter parsing.
    for (const r of routes.filter((x) => x.rule!.kind !== 'public')) {
      const path = r.route.replace(/:[a-zA-Z]+/g, 'x');
      const res = await (r.method === 'POST' ? http().post(path).send({}) : http().get(path));
      expect(res.status, `${r.method} ${r.route}`).toBe(401);
      expect(res.body.code, `${r.method} ${r.route}`).toBe('UNAUTHENTICATED');
    }
  });

  it('sign-in: secure session cookie, the current user, roles and permissions from the database', async () => {
    const res = await signIn('owner@ayvo.test', '/admin/users');
    expect(res.headers.location).toBe('/admin/users');
    const raw = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('ayvo_session='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Lax/);
    const token = cookieFrom(res, 'ayvo_session')!;
    // Only the hash is stored.
    expect(await t.prisma.userSession.count({ where: { tokenSha256: token } })).toBe(0);

    const me = (await http().get('/api/auth/me').set('Cookie', `ayvo_session=${token}`).expect(200))
      .body as CurrentUser;
    expect(me).toMatchObject({ user: { email: 'owner@ayvo.test' }, roles: ['ADMIN'] });
    expect(me.permissions).toEqual(['identity:users_manage', 'identity:users_read']);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'LOGIN_SUCCEEDED', targetUserId: me.user.id },
      }),
    ).toBeGreaterThan(0);
  });

  it('only pre-provisioned users get in; unknown identities are refused and audited', async () => {
    const email = unique('stranger');
    const res = await signIn(email);
    expect(res.headers.location).toBe('/account-inactive?reason=no-access');
    expect(cookieFrom(res, 'ayvo_session')).toBeNull();
    expect(await t.prisma.user.count({ where: { email } })).toBe(0);
    const denied = await t.prisma.auditEvent.findMany({ where: { type: 'LOGIN_DENIED' } });
    expect(denied.some((a) => (a.payload as { email?: string }).email === email)).toBe(true);
  });

  it('a callback is single-use, bound to the starting browser, and never redirects off-site', async () => {
    const start = await http()
      .get('/api/auth/login')
      .query({ next: '//evil.example/x', login_hint: 'owner@ayvo.test' });
    const binding = cookieFrom(start, 'ayvo_login');
    const provider = await http().get(
      new URL(start.headers.location!).pathname + new URL(start.headers.location!).search,
    );
    const callback = new URL(provider.headers.location!);
    const path = callback.pathname + callback.search;
    // Another browser (no / wrong binding cookie) cannot complete it.
    expect((await http().get(path)).headers.location).toBe('/login?error=invalid');
    expect(
      (await http().get(path).set('Cookie', 'ayvo_login=AAAAAAAAAAAAAAAAAAAAAA')).headers.location,
    ).toBe('/login?error=invalid');
    // Failed attempts do not consume the state; the right browser completes it (the hostile
    // "next" was replaced by "/") — once: a replay of the same callback is refused.
    expect((await http().get(path).set('Cookie', `ayvo_login=${binding}`)).headers.location).toBe(
      '/',
    );
    expect((await http().get(path).set('Cookie', `ayvo_login=${binding}`)).headers.location).toBe(
      '/login?error=invalid',
    );
    const absolute = await signIn('owner@ayvo.test', 'https://evil.example');
    expect(absolute.headers.location).toBe('/');
  });

  it('permissions are explicit per route and scoped to the warehouse', async () => {
    const operator = await createUser(['WAREHOUSE_OPERATOR']);
    const cookie = await session(operator.email);
    await http().get('/api/admin/inventory/stock').set('Cookie', cookie).expect(200);
    const correction = await http()
      .post('/api/admin/goods-receipts/GR-000001/corrections')
      .set('Cookie', cookie)
      .send({});
    expect(correction.status).toBe(403);
    expect(correction.body).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: expect.any(String),
    });
    expect((await http().get('/api/admin/identity/users').set('Cookie', cookie)).status).toBe(403);
    expect((await http().get('/api/admin/bottles').set('Cookie', cookie)).status).toBe(403);

    // The same role without the warehouse scope reads nothing in the warehouse.
    const unscoped = await createUser(['WAREHOUSE_OPERATOR'], []);
    const unscopedCookie = await session(unscoped.email);
    expect(
      (await http().get('/api/admin/inventory/stock').set('Cookie', unscopedCookie)).status,
    ).toBe(403);

    // Roles without implemented modules grant nothing internal.
    for (const role of ['SALES', 'FINANCE', 'HOTEL_USER'] as const) {
      const user = await createUser([role]);
      const c = await session(user.email);
      for (const path of [
        '/api/admin/inventory/stock',
        '/api/admin/bottles',
        '/api/admin/identity/users',
      ]) {
        expect((await http().get(path).set('Cookie', c)).status, `${role} ${path}`).toBe(403);
      }
    }
  });

  it('identity is never taken from headers', async () => {
    const operator = await createUser(['PRODUCTION_SUPERVISOR']);
    for (const headers of [
      { 'X-User-Id': operator.id },
      { 'X-User-Email': operator.email, 'X-User-Roles': 'ADMIN' },
      { Authorization: `Bearer ${operator.id}` },
      { 'X-Forwarded-User': operator.email },
    ]) {
      const res = await http().get('/api/admin/bottles').set(headers);
      expect(res.status).toBe(401);
    }
  });

  it('a role change applies to the very next request; deactivation ends access immediately', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR', 'PRODUCTION_OPERATOR']);
    const cookie = await session(user.email);
    await http().get('/api/admin/bottles').set('Cookie', cookie).expect(200);

    await http()
      .post(`/api/admin/identity/users/${user.id}/roles/revoke`)
      .set('Cookie', adminCookie)
      .send({ role: 'PRODUCTION_OPERATOR', reason: 'moved to the warehouse' })
      .expect(200);
    expect((await http().get('/api/admin/bottles').set('Cookie', cookie)).status).toBe(403);
    await http().get('/api/admin/inventory/stock').set('Cookie', cookie).expect(200);

    const deactivated = await http()
      .post(`/api/admin/identity/users/${user.id}/deactivate`)
      .set('Cookie', adminCookie)
      .send({ reason: 'left the company' })
      .expect(200);
    expect((deactivated.body as AdminUserDetail).activeSessions).toBe(0);
    const after = await http().get('/api/admin/inventory/stock').set('Cookie', cookie);
    // The session was revoked with the deactivation, and the user learns why.
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('ACCOUNT_INACTIVE');
    expect((await signIn(user.email)).headers.location).toBe('/account-inactive');

    await http()
      .post(`/api/admin/identity/users/${user.id}/reactivate`)
      .set('Cookie', adminCookie)
      .send({ reason: 'returned' })
      .expect(200);
    const renewed = await session(user.email);
    await http().get('/api/admin/inventory/stock').set('Cookie', renewed).expect(200);

    const detail = (
      await http()
        .get(`/api/admin/identity/users/${user.id}`)
        .set('Cookie', adminCookie)
        .expect(200)
    ).body as AdminUserDetail;
    expect(detail.audit.map((a) => a.type)).toEqual(
      expect.arrayContaining([
        'USER_CREATED',
        'ROLE_GRANTED',
        'ROLE_REVOKED',
        'USER_DEACTIVATED',
        'USER_REACTIVATED',
        'LOGIN_DENIED',
      ]),
    );
    expect(detail.audit.find((a) => a.type === 'USER_DEACTIVATED')).toMatchObject({
      actor: 'owner@ayvo.test',
      reason: 'left the company',
    });
  });

  it('a session that is used while still logged in at a deactivated user answers ACCOUNT_INACTIVE', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const cookie = await session(user.email);
    // Deactivated directly in the database (e.g. by another process) while the session is open.
    await t.prisma.user.update({
      where: { id: user.id },
      data: { status: 'DEACTIVATED', deactivatedAt: new Date(), deactivationReason: 'direct' },
    });
    const res = await http().get('/api/admin/inventory/stock').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  it('idle and absolute expiry end the session; logout ends it too', async () => {
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const idle = await session(user.email);
    await t.prisma.userSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { idleExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await http().get('/api/admin/inventory/stock').set('Cookie', idle);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('SESSION_EXPIRED');

    const cookie = await session(user.email);
    const logout = await http().post('/api/auth/logout').set('Cookie', cookie).expect(200);
    expect(logout.body).toEqual({ redirectUrl: '/login?signed_out=1' });
    expect(([] as string[]).concat(logout.headers['set-cookie'] ?? []).join()).toMatch(
      /ayvo_session=;.*Max-Age=0/,
    );
    const after = await http().get('/api/admin/inventory/stock').set('Cookie', cookie);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('UNAUTHENTICATED');
  });

  it('state-changing requests from another origin are refused', async () => {
    const res = await http()
      .post('/api/auth/logout')
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_REJECTED');
    const site = await http()
      .post('/api/auth/logout')
      .set('Cookie', adminCookie)
      .set('Sec-Fetch-Site', 'cross-site');
    expect(site.body.code).toBe('CSRF_REJECTED');
    await http()
      .get('/api/auth/me')
      .set('Cookie', adminCookie)
      .set('Origin', 'https://evil.example')
      .expect(200);
  });

  it('the first administrator is bootstrapped once; the last active administrator is protected', async () => {
    expect(
      await bootstrapFirstAdmin(t.prisma, { email: unique('second'), displayName: 'X' }),
    ).toEqual({
      ok: false,
      reason: 'ALREADY_BOOTSTRAPPED',
    });
    await expect(
      t.prisma.identityBootstrap.create({
        data: { userId: (await createUser([])).id, email: 'x@ayvo.test' },
      }),
    ).rejects.toThrow();
    expect(await t.prisma.auditEvent.count({ where: { type: 'ADMIN_BOOTSTRAPPED' } })).toBe(1);

    const me = (await http().get('/api/auth/me').set('Cookie', adminCookie)).body as CurrentUser;
    const self = await http()
      .post(`/api/admin/identity/users/${me.user.id}/deactivate`)
      .set('Cookie', adminCookie)
      .send({ reason: 'oops' });
    expect(self.body.code).toBe('CANNOT_DEACTIVATE_SELF');
    const last = await http()
      .post(`/api/admin/identity/users/${me.user.id}/roles/revoke`)
      .set('Cookie', adminCookie)
      .send({ role: 'ADMIN', reason: 'oops' });
    expect(last.body.code).toBe('LAST_ADMIN');

    // With a second administrator the first may step down.
    const second = await createUser(['ADMIN'], []);
    await http()
      .post(`/api/admin/identity/users/${second.id}/roles/revoke`)
      .set('Cookie', adminCookie)
      .send({ role: 'ADMIN', reason: 'temporary admin no longer needed' })
      .expect(200);
  });

  it('administration validates input and keeps history append-only', async () => {
    const bad = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', adminCookie)
      .send({
        email: 'not-an-email',
        displayName: '',
        roles: ['GOD'],
        warehouseCodes: [],
        reason: '',
      });
    expect(bad.status).toBe(400);
    const user = await createUser(['WAREHOUSE_OPERATOR']);
    const again = await http().post('/api/admin/identity/users').set('Cookie', adminCookie).send({
      email: user.email,
      displayName: 'Dup',
      roles: [],
      warehouseCodes: [],
      reason: 'duplicate',
    });
    expect(again.body.code).toBe('USER_EXISTS');
    const unknown = await http()
      .post(`/api/admin/identity/users/${user.id}/warehouses/grant`)
      .set('Cookie', adminCookie)
      .send({ warehouseCode: 'NOWHERE', reason: 'test' });
    expect(unknown.body.code).toBe('UNKNOWN_WAREHOUSE');
    await expect(t.prisma.$executeRaw`DELETE FROM "audit_events"`).rejects.toThrow(/not allowed/);
    await expect(
      t.prisma.$executeRaw`DELETE FROM "user_roles" WHERE "user_id" = ${user.id}::uuid`,
    ).rejects.toThrow(/not allowed/);
  });

  it('the public passport and health stay public', async () => {
    await http().get('/api/health').expect(200);
    const res = await http().get('/api/public/bottles/AAAAAAAAAAAAAAAAAAAAAA');
    expect(res.status).toBe(404); // public route: not 401
  });

  it('the fake provider does not exist outside APP_ENV=test', async () => {
    const dev = await createTestApp({ APP_ENV: 'development' }, {}, { auth: 'real' });
    try {
      await request(dev.app.getHttpServer())
        .get('/api/auth/test-provider/authorize')
        .query({
          state: 'x',
          redirect_uri: `${TEST_APP_ORIGIN}/api/auth/callback`,
          login_hint: 'owner@ayvo.test',
        })
        .expect(404);
      const login = await request(dev.app.getHttpServer()).get('/api/auth/login').expect(302);
      expect(new URL(login.headers.location!).hostname).toBe('api.workos.com');
    } finally {
      await dev.close();
    }
  });
});
