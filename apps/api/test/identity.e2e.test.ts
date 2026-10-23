import { randomUUID } from 'node:crypto';
import {
  isPlannedRole,
  PERMISSION_CODES,
  SECURITY_ADMIN_PERMISSIONS,
  SITE_SCOPED_PERMISSIONS,
  SYSTEM_ROLE_CODES,
  WAREHOUSE_SCOPED_PERMISSIONS,
  type SystemRoleCode,
  type AdminUserDetail,
  type CurrentUser,
  type GoodsReceipt,
  type RoleCode,
  type StockSummary,
} from '@ayvo/types';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_METADATA, type AccessRule } from '../src/identity/access.decorators.js';
import { bootstrapFirstAdmin } from '../src/identity/bootstrap.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { newBottleItemId, PDF_BYTES } from './support/warehouse-fixtures.js';

/**
 * The approved role → permission matrix (doc 021 §4). ADMIN holds every permission through
 * ordinary role_permissions rows — a permission added by a later migration fails this test until
 * it is reviewed and granted to ADMIN explicitly.
 */
const ROLE_MATRIX: Record<SystemRoleCode, readonly string[]> = {
  ADMIN: [...PERMISSION_CODES],
  WAREHOUSE_OPERATOR: ['inventory:read', 'inventory:receive', 'crates:read'],
  WAREHOUSE_SUPERVISOR: [
    'inventory:read',
    'inventory:receive',
    'inventory:correct',
    'inventory:items_manage',
    'procurement:suppliers_manage',
    'procurement:documents_read',
    'catalog:read',
    'catalog:weights_record',
    'crates:read',
    'crates:register',
  ],
  PRODUCTION_OPERATOR: [
    'production:read',
    'production:labels_print',
    'inventory:read',
    'catalog:read',
    'crates:read',
    'production:fill',
    'production:label_apply',
  ],
  // Label templates are company-wide brand data: not changed by a site-bound role.
  PRODUCTION_SUPERVISOR: [
    'production:read',
    'production:labels_print',
    'production:bottles_create',
    'production:label_apply',
    'inventory:read',
    'catalog:read',
    'catalog:product_manage',
    'catalog:recipe_approve',
    'catalog:weights_record',
    'crates:read',
    'crates:register',
    'production:workstations_manage',
    'production:fill',
    'production:session_takeover',
    'production:cycle_correct',
  ],
  SALES: ['sales:work'],
  FINANCE: [
    'inventory:read',
    'procurement:cost_read',
    'procurement:cost_write',
    'procurement:documents_read',
  ],
  HOTEL_USER: [],
};

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

  /** A user with roles and access to the given sites (default: the initial site). */
  /**
   * Creates a user through the API. Planned system roles (SALES, FINANCE, HOTEL_USER) can no
   * longer be assigned there (doc 021 §4c); their permission templates are still tested through
   * an assignment written directly — the situation of an assignment that already existed.
   */
  async function createUser(
    roles: RoleCode[],
    siteIds: string[] = [INITIAL_SITE_ID],
    warehouseCodes: string[] = [],
  ) {
    const res = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', adminCookie)
      .send({
        email: unique('user'),
        displayName: 'Test User',
        roles: roles.filter((r) => !isPlannedRole(r)),
        siteIds,
        warehouseCodes,
        reason: 'test setup',
      })
      .expect(201);
    const user = res.body as AdminUserDetail;
    for (const role of roles.filter(isPlannedRole)) {
      await t.prisma.userRole.create({
        data: { userId: user.id, roleCode: role, grantReason: 'pre-existing assignment (test)' },
      });
    }
    return user;
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const result = await bootstrapFirstAdmin(t.prisma, {
      email: 'owner@ayvo.test',
      displayName: 'Owner',
    });
    expect(result).toMatchObject({ ok: true });
    adminCookie = await session('owner@ayvo.test');
    // Other test files may have added sites: the administrator works at the initial one.
    await http()
      .post('/api/auth/active-site')
      .set('Cookie', adminCookie)
      .send({ siteId: INITIAL_SITE_ID })
      .expect(200);
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
      // Only "an AYVO returnable crate" (doc 020 §3.4, doc 025 A1).
      'GET /api/public/crates/:token',
      // Only "an internal AYVO mark" (doc 026).
      'GET /api/public/workstations/:token',
    ]);
    // Machine routes (ADR 0028): only the print agent's API, only under /api/agent/.
    expect(
      routes
        .filter((r) => r.rule!.kind === 'agent')
        .map((r) => `${r.method} ${r.route}`)
        .sort(),
    ).toEqual([
      'GET /api/agent/v1/jobs/:id/data',
      'POST /api/agent/v1/heartbeat',
      'POST /api/agent/v1/jobs/:id/result',
      'POST /api/agent/v1/jobs/:id/start',
      'POST /api/agent/v1/jobs/claim',
    ]);
    // Without a session every other route answers 401 — guards run before any parameter parsing;
    // an agent route without the agent's token too (a session never counts there).
    for (const r of routes.filter((x) => x.rule!.kind !== 'public')) {
      const path = r.route.replace(/:[a-zA-Z]+/g, 'x');
      const res = await (r.method === 'POST' ? http().post(path).send({}) : http().get(path));
      expect(res.status, `${r.method} ${r.route}`).toBe(401);
      expect(res.body.code, `${r.method} ${r.route}`).toBe(
        r.rule!.kind === 'agent' ? 'AGENT_UNAUTHORIZED' : 'UNAUTHENTICATED',
      );
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
    expect(me).toMatchObject({
      user: { email: 'owner@ayvo.test' },
      roles: [{ code: 'ADMIN', name: 'Administrátor' }],
    });
    expect(me.permissions).toEqual([...PERMISSION_CODES].sort());
    // ADMIN's global site access is an explicit permission evaluated by the server — no scope
    // rows; with one site it is selected automatically.
    expect(me.scopes).toEqual([]);
    expect(me.globalSiteAccess).toBe(true);
    const initial = me.sites.find((x) => x.id === INITIAL_SITE_ID);
    expect(initial).toMatchObject({
      code: 'CZ-PREROV-01',
      allWarehouses: true,
      // Other test files may add warehouses to the initial site.
      warehouses: expect.arrayContaining([expect.objectContaining({ code: 'MAIN' })]),
    });
    // A single site is selected automatically; with several the user chooses.
    expect(me.activeSiteId).toBe(me.sites.length === 1 ? INITIAL_SITE_ID : null);
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

  it('permissions are explicit per route and scoped to the site and its warehouse', async () => {
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

    // The same role without site access reads nothing in the warehouse.
    const unscoped = await createUser(['WAREHOUSE_OPERATOR'], []);
    const unscopedCookie = await session(unscoped.email);
    const refused = await http().get('/api/admin/inventory/stock').set('Cookie', unscopedCookie);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('SITE_REQUIRED');

    // The hotel role grants nothing internal.
    const hotel = await createUser(['HOTEL_USER']);
    const hotelCookie = await session(hotel.email);
    for (const path of [
      '/api/admin/inventory/stock',
      '/api/admin/inventory/stock-summary',
      '/api/admin/goods-receipts',
      '/api/admin/bottles',
      '/api/admin/identity/users',
    ]) {
      expect((await http().get(path).set('Cookie', hotelCookie)).status, path).toBe(403);
    }
  });

  it('the role catalogue in the database is exactly the approved matrix; ADMIN holds every permission', async () => {
    const catalogue = await t.prisma.permission.findMany({ orderBy: { code: 'asc' } });
    expect(catalogue.map((p) => p.code)).toEqual([...PERMISSION_CODES].sort());
    expect(catalogue.filter((p) => p.warehouseScoped).map((p) => p.code)).toEqual(
      [...WAREHOUSE_SCOPED_PERMISSIONS].sort(),
    );
    expect(catalogue.filter((p) => p.siteScoped).map((p) => p.code)).toEqual(
      [...SITE_SCOPED_PERMISSIONS].sort(),
    );
    expect(catalogue.filter((p) => p.securityAdmin).map((p) => p.code)).toEqual(
      [...SECURITY_ADMIN_PERMISSIONS].sort(),
    );
    const systemRoles = await t.prisma.role.findMany({ where: { isSystem: true } });
    expect(systemRoles.map((x) => x.code).sort()).toEqual([...SYSTEM_ROLE_CODES].sort());
    const grants = await t.prisma.rolePermission.findMany({ where: { role: { isSystem: true } } });
    for (const role of SYSTEM_ROLE_CODES) {
      expect(
        grants
          .filter((g) => g.roleCode === role)
          .map((g) => g.permissionCode)
          .sort(),
        role,
      ).toEqual([...ROLE_MATRIX[role]].sort());
    }
    // System roles and the permission catalogue change only by migration.
    await expect(
      t.prisma.rolePermission.deleteMany({ where: { roleCode: 'ADMIN' } }),
    ).rejects.toThrow(/only by migration/);
    await expect(
      t.prisma.rolePermission.create({
        data: { roleCode: 'SALES', permissionCode: 'inventory:read' },
      }),
    ).rejects.toThrow(/only by migration/);
    await expect(
      t.prisma.role.update({ where: { code: 'SALES' }, data: { name: 'Prodej' } }),
    ).rejects.toThrow(/only by migration/);
    await expect(t.prisma.role.delete({ where: { code: 'HOTEL_USER' } })).rejects.toThrow();
    await expect(
      t.prisma.role.create({
        data: { code: 'SNEAKY', name: 'x', description: '', isSystem: true },
      }),
    ).rejects.toThrow(/only by migration/);
    await expect(
      t.prisma.permission.create({
        data: { code: 'inventory:anything', description: 'x', warehouseScoped: false },
      }),
    ).rejects.toThrow(/only by migration/);
  });

  describe('purchase prices and supplier documents', () => {
    let receipt: GoodsReceipt;
    let documentId: string;
    let supplierId: string;

    beforeAll(async () => {
      supplierId = (
        await http()
          .post('/api/admin/suppliers')
          .set('Cookie', adminCookie)
          .send({
            requestId: randomUUID(),
            name: `Cost ${randomUUID()}`,
            companyId: null,
            vatId: null,
          })
          .expect(201)
      ).body.id;
      documentId = (
        await http()
          .post('/api/admin/supplier-documents')
          .set('Cookie', adminCookie)
          .field('requestId', randomUUID())
          .field('supplierId', supplierId)
          .field('kind', 'INVOICE')
          .field('documentNumber', 'FV-SECRET-1')
          .field('issuedOn', '2026-10-11')
          .attach('file', PDF_BYTES, 'invoice.pdf')
          .expect(201)
      ).body.id;
      receipt = (
        await http()
          .post('/api/admin/goods-receipts')
          .set('Cookie', adminCookie)
          .send({
            requestId: randomUUID(),
            supplierId,
            supplierReference: 'FV-SECRET-1',
            receivedAt: new Date().toISOString(),
            note: null,
            documentIds: [documentId],
            lines: [
              {
                itemId: await newBottleItemId(t),
                quantity: '10',
                supplierLotCode: null,
                unitPrice: '987.6543',
                currency: 'CZK',
                vatRate: '21',
              },
            ],
          })
          .expect(201)
      ).body as GoodsReceipt;
      // ADMIN sees everything.
      expect(receipt.lines[0]).toMatchObject({ unitPrice: '987.6543', currency: 'CZK' });
      expect(receipt.documents).toHaveLength(1);
    });

    const leaks = (body: unknown) => {
      const text = JSON.stringify(body);
      return ['987.6543', 'unitPrice', 'vatRate', 'currency'].filter((x) => text.includes(x));
    };

    it.each([
      ['WAREHOUSE_OPERATOR', { costs: false, documents: false }],
      ['WAREHOUSE_SUPERVISOR', { costs: false, documents: true }],
      ['PRODUCTION_OPERATOR', { costs: false, documents: false }],
      ['PRODUCTION_SUPERVISOR', { costs: false, documents: false }],
      ['FINANCE', { costs: true, documents: true }],
      // ADMIN: covered by the setup above (a second ADMIN here would disarm the last-admin test).
    ] as const)(
      '%s: receipt costs and documents are filtered by the server (%o)',
      async (role, may) => {
        const user = await createUser([role]);
        const cookie = await session(user.email);
        const detail = await http()
          .get(`/api/admin/goods-receipts/${receipt.code}`)
          .set('Cookie', cookie)
          .expect(200);
        const line = detail.body.lines[0];
        if (may.costs) {
          expect(line).toMatchObject({ unitPrice: '987.6543', currency: 'CZK', vatRate: '21' });
        } else {
          expect(leaks(detail.body)).toEqual([]);
          expect(Object.keys(line)).not.toContain('unitPrice');
        }
        expect('documents' in detail.body).toBe(may.documents);
        const list = await http()
          .get(`/api/admin/suppliers/${supplierId}/documents`)
          .set('Cookie', cookie);
        expect(list.status).toBe(may.documents ? 200 : 403);
        const file = await http()
          .get(`/api/admin/supplier-documents/${documentId}/content`)
          .set('Cookie', cookie);
        expect(file.status).toBe(may.documents ? 200 : 403);
        if (!may.documents) expect(file.text ?? '').not.toContain('%PDF');
        // The receipt list never carries prices.
        const receipts = await http().get('/api/admin/goods-receipts').set('Cookie', cookie);
        expect(receipts.status).toBe(200);
        expect(leaks(receipts.body)).toEqual([]);
      },
    );

    it('prices are written only with cost_write; replays and responses never leak them', async () => {
      const operator = await createUser(['WAREHOUSE_OPERATOR']);
      const cookie = await session(operator.email);
      const upload = await http()
        .post('/api/admin/supplier-documents')
        .set('Cookie', cookie)
        .field('requestId', randomUUID())
        .field('supplierId', supplierId)
        .field('kind', 'DELIVERY_NOTE')
        .field('documentNumber', 'DL-OP-1')
        .field('issuedOn', '2026-10-11')
        .attach('file', PDF_BYTES, 'note.pdf')
        .expect(201);
      const line = {
        itemId: await newBottleItemId(t),
        quantity: '1',
        supplierLotCode: null,
        unitPrice: null as string | null,
        currency: null as string | null,
        vatRate: null as string | null,
      };
      const body = (prices: Partial<typeof line> = {}) => ({
        requestId: randomUUID(),
        supplierId,
        supplierReference: 'DL-OP-1',
        receivedAt: new Date().toISOString(),
        note: null,
        documentIds: [upload.body.id],
        lines: [{ ...line, ...prices }],
      });

      // Warehouse staff record quantities, never prices — not even as a hidden form field, and
      // not by replaying a priced request of someone else.
      const priced = body({ unitPrice: '987.6543', currency: 'CZK' });
      const refused = await http()
        .post('/api/admin/goods-receipts')
        .set('Cookie', cookie)
        .send(priced);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('COST_WRITE_REQUIRED');
      await http()
        .post('/api/admin/goods-receipts')
        .set('Cookie', adminCookie)
        .send(priced)
        .expect(201);
      const replay = await http()
        .post('/api/admin/goods-receipts')
        .set('Cookie', cookie)
        .send(priced);
      expect(replay.status).toBe(403);
      expect(leaks(replay.body)).toEqual([]);
      const supervisor = await session((await createUser(['WAREHOUSE_SUPERVISOR'])).email);
      expect(
        (
          await http()
            .post('/api/admin/goods-receipts')
            .set('Cookie', supervisor)
            .send(body({ vatRate: '21', unitPrice: '1', currency: 'CZK' }))
        ).body.code,
      ).toBe('COST_WRITE_REQUIRED');

      // A quantity-only receipt: responses and replays carry neither prices nor documents.
      const plain = body();
      let code = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await http()
          .post('/api/admin/goods-receipts')
          .set('Cookie', cookie)
          .send(plain)
          .expect(201);
        expect(leaks(res.body)).toEqual([]);
        expect('documents' in res.body).toBe(false);
        code = res.body.code;
      }

      // FINANCE completes the price later: append-only, reason, audited with actor and site.
      const finance = await createUser(['FINANCE']);
      const financeCookie = await session(finance.email);
      const costBody = {
        requestId: randomUUID(),
        unitPrice: '12.5',
        currency: 'EUR',
        vatRate: '19',
        reason: 'invoice FV-2026-77 arrived',
      };
      const completed = await http()
        .post(`/api/admin/goods-receipts/${code}/lines/1/cost`)
        .set('Cookie', financeCookie)
        .send(costBody)
        .expect(200);
      expect(completed.body.lines[0]).toMatchObject({
        unitPrice: '12.5',
        currency: 'EUR',
        vatRate: '19',
        costUpdatedAt: expect.any(String),
      });
      const event = await t.prisma.auditEvent.findFirstOrThrow({
        where: { type: 'RECEIPT_COST_CORRECTED', actorUserId: finance.id },
      });
      expect(event).toMatchObject({
        reason: 'invoice FV-2026-77 arrived',
        siteId: INITIAL_SITE_ID,
      });
      expect(event.payload).toMatchObject({ receipt: code, lineNo: 1, unitPrice: '12.5' });
      await expect(
        t.prisma.goodsReceiptLineCost.deleteMany({ where: { reason: costBody.reason } }),
      ).rejects.toThrow();
      // Staff without cost_write cannot correct; the operator still sees no price.
      expect(
        (
          await http()
            .post(`/api/admin/goods-receipts/${code}/lines/1/cost`)
            .set('Cookie', supervisor)
            .send({ ...costBody, requestId: randomUUID() })
        ).status,
      ).toBe(403);
      const seen = await http().get(`/api/admin/goods-receipts/${code}`).set('Cookie', cookie);
      expect(leaks(seen.body)).toEqual([]);
      expect(JSON.stringify(seen.body)).not.toContain('costUpdatedAt');

      const linked = await http()
        .post(`/api/admin/goods-receipts/${receipt.code}/documents`)
        .set('Cookie', cookie)
        .send({ requestId: randomUUID(), documentId: upload.body.id })
        .expect(200);
      expect(leaks(linked.body)).toEqual([]);
      expect('documents' in linked.body).toBe(false);
    });
  });

  it('SALES works in Obchod only: no site, no stock, nothing operational (doc 034)', async () => {
    // Assignable through the API since Obchod exists, without any site.
    const salesperson = await createUser(['SALES'], []);
    const salesCookie = await session(salesperson.email);
    const me = (await http().get('/api/auth/me').set('Cookie', salesCookie).expect(200))
      .body as CurrentUser;
    expect(me.permissions).toEqual(['sales:work']);
    expect(me.activeSiteId).toBeNull();
    await http().get('/api/admin/sales/overview').set('Cookie', salesCookie).expect(200);
    await http().get('/api/admin/sales/prospects').set('Cookie', salesCookie).expect(200);
    for (const path of [
      '/api/admin/inventory/stock-summary',
      '/api/admin/inventory/stock',
      '/api/admin/goods-receipts',
      '/api/admin/bottles',
      '/api/admin/orders',
      '/api/admin/hotels',
      '/api/admin/identity/users',
      '/api/admin/sales/salespeople',
    ]) {
      expect((await http().get(path).set('Cookie', salesCookie)).status, path).toBe(403);
    }
  });

  it('a planning role reads the stock summary only and nothing operational', async () => {
    // The former SALES template (doc 021) lives on as a custom role ADMIN may build.
    await http()
      .post('/api/admin/identity/roles')
      .set('Cookie', adminCookie)
      .send({
        code: 'E2E_PLANNING',
        name: 'Plánování (test)',
        description: 'Stock availability for planning',
        permissions: ['inventory:stock_summary'],
        copiedFrom: null,
        reason: 'planning availability test',
      })
      .expect(201);
    const sales = await createUser(['E2E_PLANNING']);
    const cookie = await session(sales.email);
    const summary = (
      await http().get('/api/admin/inventory/stock-summary').set('Cookie', cookie).expect(200)
    ).body as StockSummary;
    expect(summary.location.code).toBe('MAIN');
    expect(summary.items.length).toBeGreaterThan(0);
    for (const row of summary.items) {
      expect(Object.keys(row).sort()).toEqual(['available', 'item', 'lowStock', 'reserved']);
      expect(Object.keys(row.item).sort()).toEqual(['code', 'name', 'unitCode']);
    }
    expect(JSON.stringify(summary)).not.toMatch(/supplier|lot|price|document|onHand/i);

    for (const path of [
      '/api/admin/inventory/stock',
      '/api/admin/inventory/items',
      '/api/admin/inventory/lots?item=NEW_BOTTLE',
      '/api/admin/inventory/movements',
      '/api/admin/goods-receipts',
      '/api/admin/suppliers',
      '/api/admin/bottles',
      '/api/admin/identity/users',
    ]) {
      expect((await http().get(path).set('Cookie', cookie)).status, path).toBe(403);
    }
    for (const path of [
      '/api/admin/goods-receipts',
      '/api/admin/goods-receipts/GR-000001/corrections',
      '/api/admin/supplier-documents',
      '/api/admin/suppliers',
      '/api/admin/inventory/items/NEW_BOTTLE/settings',
      '/api/admin/label-applications',
    ]) {
      expect((await http().post(path).set('Cookie', cookie).send({})).status, path).toBe(403);
    }
    // Warehouse-scoped like every stock read: without the warehouse no summary either.
    const unscoped = await createUser(['E2E_PLANNING'], []);
    const unscopedCookie = await session(unscoped.email);
    await http()
      .get('/api/admin/inventory/stock-summary')
      .set('Cookie', unscopedCookie)
      .expect(403);
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

    // The database refuses it too — whatever the code path, also when everything happens in one
    // transaction (checked at commit), and TRUNCATE of the role catalogue is refused.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "user_roles" SET "revoked_at" = now(), "revoke_reason" = 'sql'
          WHERE "role_code" = 'ADMIN' AND "revoked_at" IS NULL`;
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "users" SET "status" = 'DEACTIVATED', "deactivated_at" = now(),
          "deactivation_reason" = 'sql' WHERE "id" IN (SELECT "user_id" FROM "user_roles"
          WHERE "role_code" = 'ADMIN' AND "revoked_at" IS NULL)`;
      }),
    ).rejects.toThrow();
    expect(
      await t.prisma.userRole.count({ where: { roleCode: 'ADMIN', revokedAt: null } }),
    ).toBeGreaterThan(0);
    for (const table of ['roles', 'permissions', 'role_permissions']) {
      await expect(t.prisma.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow();
    }

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
