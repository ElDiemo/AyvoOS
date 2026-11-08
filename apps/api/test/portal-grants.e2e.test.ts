import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsService } from '../src/identity/sessions.service.js';
import { createHotel } from './support/order-fixtures.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (cookie: string) => cookie.replace(/^ayvo_session=/, '');
const ADMIN_REASONS = ['portal grants test', 'second administrator'];

/**
 * Hotel portal grants (ADR 0045 §4 on `0d500f6`, PR 2): issued and replaced only through
 * Finance's contract call (Finance token AND the admin's forwarded session, permissions re-checked
 * by the core), revoked by the core's admin route. One active grant per (user, payer); a change
 * of scope is an atomic replacement; replacement and revocation of one grant never both win.
 * Synthetic accounts, payers and hotels only. Finance's own check of the pair (payer, hotels) is
 * PR 4; here the core's side of the contract is exercised directly, as Finance will call it.
 */
describe.skipIf(!hasDatabase)('portal grants', () => {
  const financeToken = randomBytes(32).toString('base64url');
  let t: TestApp;
  let su: TestApp;
  let admin: string;
  let operator: string;
  let hotels: string[];

  const core = () => request(t.app.getHttpServer());
  /** Finance's call: its token and the forwarded staff session. */
  const contract = (path: string, session = admin) =>
    core()
      .post(`/api/internal/v1/finance/${path}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('x-ayvo-session', tokenOf(session));
  const revokeRoute = (id: string, cookie = admin) =>
    core().post(`/api/admin/identity/portal-grants/${id}/revoke`).set('Cookie', cookie);

  const portalAccount = async () =>
    t.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal account', audience: 'PORTAL' },
    });
  const body = (hotelIds: string[], payerCustomerId: string = randomUUID()) => ({
    requestId: randomUUID() as string,
    payerCustomerId,
    hotelIds,
    reason: 'synthetic portal grant',
    financeCheck: { payerVersionId: randomUUID(), hotelIds, checkedAt: new Date().toISOString() },
  });
  const issue = async (userId: string, hotelIds: string[], payer: string = randomUUID()) => {
    const res = await contract('portal-grants').send({ userId, ...body(hotelIds, payer) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; hotelIds: string[]; payerCustomerId: string };
  };
  const active = (userId: string) =>
    t.prisma.portalGrant.findMany({
      where: { userId, revokedAt: null },
      include: { hotels: true },
    });
  const written = async (userId: string) => ({
    grants: await t.prisma.portalGrant.count({ where: { userId } }),
    audit: await t.prisma.auditEvent.count({
      where: { targetUserId: userId, type: { startsWith: 'PORTAL_GRANT_' } },
    }),
  });

  /** A portal session of the account (the portal sign-in comes in PR 3). */
  async function portalSession(userId: string, email: string) {
    const identity = await t.prisma.userIdentity.create({
      data: { userId, provider: 'LOCAL', subject: userId, emailAtLink: email },
    });
    const s = await t.prisma.$transaction((tx) =>
      t.app.get(SessionsService).create(tx, {
        userId,
        identityId: identity.id,
        providerSessionId: null,
        audience: 'PORTAL',
      }),
    );
    return s.token;
  }

  /** Waits until n backends of this database wait for a lock. */
  async function waiters(n: number) {
    for (let i = 0; i < 200; i++) {
      const [row] = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${n} lock waiters`);
  }

  /**
   * Runs `first` and `second` in exactly this order on one account: both queue behind a held
   * lock of the account's user row (the first lock either takes), then the lock is released.
   */
  async function inOrder<A, B>(userId: string, first: () => Promise<A>, second: () => Promise<B>) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    // A supertest request is sent only once it is awaited: start it now.
    const a = Promise.resolve(first());
    await waiters(1);
    const b = Promise.resolve(second());
    await waiters(2);
    release();
    await holder;
    return Promise.all([a, b]);
  }

  beforeAll(async () => {
    t = await createTestApp(
      { FINANCE_SERVICE_TOKEN_SHA256: createHash('sha256').update(financeToken).digest('hex') },
      {},
      { auth: 'real' },
    );
    su = await createTestApp();
    const a = await prepareInvitedUser(t, { email: unique('grants-admin'), displayName: 'Admin' });
    await t.prisma.userRole.create({
      data: { userId: a.id, roleCode: 'ADMIN', grantReason: 'portal grants test' },
    });
    admin = await sessionCookie(t, a.email);
    const o = await prepareInvitedUser(t, { email: unique('grants-op'), displayName: 'Operator' });
    await t.prisma.userRole.create({
      data: { userId: o.id, roleCode: 'WAREHOUSE_OPERATOR', grantReason: 'portal grants test' },
    });
    operator = await sessionCookie(t, o.email);
    hotels = [];
    for (const name of ['Hotel Portál A', 'Hotel Portál B', 'Hotel Portál C'])
      hotels.push((await createHotel(su, { name })).id);
  });
  afterAll(async () => {
    // Other test files bootstrap the first ADMIN: leave no open ADMIN grant behind.
    await t?.prisma.userRole.updateMany({
      where: { roleCode: 'ADMIN', revokedAt: null, grantReason: { in: ADMIN_REASONS } },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
    await su?.close();
  });

  describe('the contract: only Finance, only for an ADMIN, never from the browser', () => {
    it('refuses a call without the Finance token, without a session or without the permissions', async () => {
      const user = await portalAccount();
      const payload = { userId: user.id, ...body([hotels[0]!]) };
      // No / wrong Finance token, with an admin session.
      expect(
        (await core().post('/api/internal/v1/finance/portal-grants').send(payload)).status,
      ).toBe(401);
      expect(
        (
          await core()
            .post('/api/internal/v1/finance/portal-grants')
            .set('Authorization', `Bearer ${'x'.repeat(43)}`)
            .set('x-ayvo-session', tokenOf(admin))
            .send(payload)
        ).status,
      ).toBe(401);
      // The browser's admin cookie does not count on the internal contract.
      expect(
        (
          await core()
            .post('/api/internal/v1/finance/portal-grants')
            .set('Authorization', `Bearer ${financeToken}`)
            .set('Cookie', admin)
            .send(payload)
        ).status,
      ).toBe(401);
      // The Finance token with a staff session lacking the permissions.
      const op = await contract('portal-grants', operator).send(payload);
      expect([op.status, op.body.code]).toEqual([403, 'FORBIDDEN']);
      // A portal session is no session on the internal contract (PR 1).
      const portal = await portalSession(user.id, user.email);
      expect((await contract('portal-grants', `ayvo_session=${portal}`).send(payload)).status).toBe(
        401,
      );
      // The revoke route needs the admin's own session and permission.
      const fake = randomUUID();
      expect((await core().post(`/api/admin/identity/portal-grants/${fake}/revoke`)).status).toBe(
        401,
      );
      expect((await revokeRoute(fake, operator).send({ reason: 'no right' })).status).toBe(403);
      expect(await written(user.id)).toEqual({ grants: 0, audit: 0 });
    });

    it('identity:portal_grants_manage is ADMIN only, security administration', async () => {
      const perm = await t.prisma.permission.findUniqueOrThrow({
        where: { code: 'identity:portal_grants_manage' },
      });
      expect(perm.securityAdmin).toBe(true);
      const holders = await t.prisma.rolePermission.findMany({
        where: { permissionCode: 'identity:portal_grants_manage' },
        select: { roleCode: true },
      });
      expect(holders.map((h) => h.roleCode)).toEqual(['ADMIN']);
    });
  });

  describe('issuing', () => {
    it('stores the grant, its hotels, what Finance confirmed, and one audit event', async () => {
      const user = await portalAccount();
      const payload = body([hotels[1]!, hotels[0]!]);
      const res = await contract('portal-grants').send({ userId: user.id, ...payload });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        userId: user.id,
        payerCustomerId: payload.payerCustomerId,
        hotelIds: [hotels[0], hotels[1]].sort(),
        financeCheck: payload.financeCheck,
        replacesGrantId: null,
        revokedAt: null,
      });
      const audit = await t.prisma.auditEvent.findMany({
        where: { targetUserId: user.id, type: 'PORTAL_GRANT_ISSUED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.payload).toMatchObject({ grantId: res.body.id });
    });

    it('refuses a staff account, an unknown hotel, an empty or unconfirmed hotel set — nothing written', async () => {
      const staff = await t.prisma.user.create({
        data: { email: unique('staff'), displayName: 'Staff' },
      });
      const s = await contract('portal-grants').send({ userId: staff.id, ...body([hotels[0]!]) });
      expect([s.status, s.body.code]).toEqual([409, 'ACCOUNT_AUDIENCE_MISMATCH']);
      expect(await written(staff.id)).toEqual({ grants: 0, audit: 0 });

      const user = await portalAccount();
      const unknown = await contract('portal-grants').send({
        userId: user.id,
        ...body([hotels[0]!, randomUUID()]),
      });
      expect([unknown.status, unknown.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
      const empty = await contract('portal-grants').send({ userId: user.id, ...body([]) });
      expect(empty.status).toBe(400);
      const unconfirmed = body([hotels[0]!, hotels[1]!]);
      unconfirmed.financeCheck.hotelIds = [hotels[0]!];
      expect(
        (await contract('portal-grants').send({ userId: user.id, ...unconfirmed })).status,
      ).toBe(400);
      const missing = await contract('portal-grants').send({
        ...body([hotels[0]!]),
        userId: randomUUID(),
      });
      expect([missing.status, missing.body.code]).toEqual([404, 'USER_NOT_FOUND']);
      expect(await written(user.id)).toEqual({ grants: 0, audit: 0 });
    });

    it('one active grant per (user, payer) — also when two arrive at once; another payer is a separate grant', async () => {
      const user = await portalAccount();
      const payer = randomUUID();
      const [a, b] = await Promise.all([
        contract('portal-grants').send({ userId: user.id, ...body([hotels[0]!], payer) }),
        contract('portal-grants').send({ userId: user.id, ...body([hotels[1]!], payer) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('GRANT_EXISTS');
      expect(await active(user.id)).toHaveLength(1);
      await issue(user.id, [hotels[2]!]);
      expect(await active(user.id)).toHaveLength(2);
    });
  });

  describe('replacing', () => {
    it('is one atomic step: a new grant replacing the old one, the old revoked "nahrazen", one audit event naming both', async () => {
      const user = await portalAccount();
      const old = await issue(user.id, [hotels[0]!]);
      const res = await contract(`portal-grants/${old.id}/replace`).send(
        body([hotels[0]!, hotels[1]!], old.payerCustomerId),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        replacesGrantId: old.id,
        hotelIds: [hotels[0], hotels[1]].sort(),
      });
      const prev = await t.prisma.portalGrant.findUniqueOrThrow({ where: { id: old.id } });
      expect(prev.revokeReason).toBe('nahrazen');
      const scope = await active(user.id);
      expect(scope.map((g) => g.id)).toEqual([res.body.id]);
      const audit = await t.prisma.auditEvent.findMany({
        where: { targetUserId: user.id, type: 'PORTAL_GRANT_REPLACED' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.payload).toMatchObject({
        grantId: res.body.id,
        replacedGrantId: old.id,
        previousHotelIds: [hotels[0]],
      });
      // Narrowing goes the same way.
      const narrowed = await contract(`portal-grants/${res.body.id}/replace`).send(
        body([hotels[1]!], old.payerCustomerId),
      );
      expect(narrowed.status).toBe(201);
      expect((await active(user.id)).map((g) => g.hotels.map((h) => h.hotelId))).toEqual([
        [hotels[1]],
      ]);
    });

    it('refuses another payer, a revoked or an already replaced grant — nothing written', async () => {
      const user = await portalAccount();
      const old = await issue(user.id, [hotels[0]!]);
      const other = await contract(`portal-grants/${old.id}/replace`).send(body([hotels[1]!]));
      expect([other.status, other.body.code]).toEqual([409, 'GRANT_PAYER_MISMATCH']);
      const next = await contract(`portal-grants/${old.id}/replace`).send(
        body([hotels[1]!], old.payerCustomerId),
      );
      expect(next.status).toBe(201);
      const before = await written(user.id);
      const again = await contract(`portal-grants/${old.id}/replace`).send(
        body([hotels[2]!], old.payerCustomerId),
      );
      expect([again.status, again.body.code, again.body.details]).toEqual([
        409,
        'GRANT_REPLACED',
        { grantId: next.body.id },
      ]);
      await revokeRoute(next.body.id).send({ reason: 'end of access' }).expect(200);
      const revoked = await contract(`portal-grants/${next.body.id}/replace`).send(
        body([hotels[2]!], old.payerCustomerId),
      );
      expect([revoked.status, revoked.body.code]).toEqual([409, 'GRANT_REVOKED']);
      expect(await written(user.id)).toEqual({ grants: before.grants, audit: before.audit + 1 });
      const missing = await contract(`portal-grants/${randomUUID()}/replace`).send(
        body([hotels[0]!]),
      );
      expect([missing.status, missing.body.code]).toEqual([404, 'GRANT_NOT_FOUND']);
    });
  });

  describe('revoking', () => {
    it('ends every portal session only when the account has no active grant left', async () => {
      const user = await portalAccount();
      const a = await issue(user.id, [hotels[0]!]);
      const b = await issue(user.id, [hotels[1]!]);
      const session = await portalSession(user.id, user.email);
      const lookup = () => t.app.get(SessionsService).lookup(session, 'PORTAL');

      const first = await revokeRoute(a.id).send({ reason: 'payer A ended' });
      expect([first.status, first.body.revokeReason]).toEqual([200, 'payer A ended']);
      expect((await lookup()).kind).toBe('active');
      await revokeRoute(b.id).send({ reason: 'payer B ended' }).expect(200);
      expect((await lookup()).kind).not.toBe('active');
      const row = await t.prisma.userSession.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.revokeReason).toBe('PORTAL_GRANT_REVOKED');
      const audit = await t.prisma.auditEvent.findMany({
        where: { targetUserId: user.id, type: 'PORTAL_GRANT_REVOKED' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audit.map((e) => (e.payload as { sessionsEnded: number }).sessionsEnded)).toEqual([
        0, 1,
      ]);
      // Never twice, never revived.
      const again = await revokeRoute(b.id).send({ reason: 'again' });
      expect([again.status, again.body.code]).toEqual([409, 'GRANT_REVOKED']);
    });
  });

  describe('a replacement and a revocation of one grant at once', () => {
    it('revocation first: the replacement is refused GRANT_REVOKED, nothing written', async () => {
      const user = await portalAccount();
      const old = await issue(user.id, [hotels[0]!]);
      const [revoke, replace] = await inOrder(
        user.id,
        () => revokeRoute(old.id).send({ reason: 'revoked first' }),
        () =>
          contract(`portal-grants/${old.id}/replace`).send(
            body([hotels[0]!, hotels[1]!], old.payerCustomerId),
          ),
      );
      expect(revoke.status).toBe(200);
      expect([replace.status, replace.body.code]).toEqual([409, 'GRANT_REVOKED']);
      expect(await active(user.id)).toEqual([]);
      expect(await t.prisma.portalGrant.count({ where: { userId: user.id } })).toBe(1);
    });

    it('replacement first: the revocation answers GRANT_REPLACED with the new grant, which stays', async () => {
      const user = await portalAccount();
      const old = await issue(user.id, [hotels[0]!]);
      const [replace, revoke] = await inOrder(
        user.id,
        () =>
          contract(`portal-grants/${old.id}/replace`).send(
            body([hotels[0]!, hotels[1]!], old.payerCustomerId),
          ),
        () => revokeRoute(old.id).send({ reason: 'revoked second' }),
      );
      expect(replace.status).toBe(201);
      expect([revoke.status, revoke.body.code, revoke.body.details]).toEqual([
        409,
        'GRANT_REPLACED',
        { grantId: replace.body.id },
      ]);
      const scope = await active(user.id);
      expect(scope.map((g) => g.id)).toEqual([replace.body.id]);
      expect(scope[0]!.hotels.map((h) => h.hotelId).sort()).toEqual([hotels[0], hotels[1]].sort());
    });
  });

  describe('the database keeps grants as history', () => {
    it('refuses edits, revival, deletion, late hotels, empty grants and staff accounts', async () => {
      const user = await portalAccount();
      const g = await issue(user.id, [hotels[0]!]);
      const sql = (q: TemplateStringsArray, ...v: unknown[]) => t.prisma.$executeRaw(q, ...v);
      await expect(
        sql`UPDATE "portal_grants" SET "reason" = 'edited' WHERE "id" = ${g.id}::uuid`,
      ).rejects.toThrow(/only ever revoked/);
      await expect(
        sql`UPDATE "portal_grants" SET "payer_customer_id" = ${randomUUID()}::uuid WHERE "id" = ${g.id}::uuid`,
      ).rejects.toThrow(/only ever revoked/);
      // Revoking and editing at once is still an edit.
      await expect(
        sql`UPDATE "portal_grants" SET "revoked_at" = now(), "revoked_by" = ${user.id}::uuid,
              "revoke_reason" = 'x', "reason" = 'edited' WHERE "id" = ${g.id}::uuid`,
      ).rejects.toThrow(/never edited/);
      await expect(
        sql`INSERT INTO "portal_grant_hotels" ("grant_id", "hotel_id") VALUES (${g.id}::uuid, ${hotels[1]}::uuid)`,
      ).rejects.toThrow(/written with the grant/);
      await expect(
        sql`DELETE FROM "portal_grant_hotels" WHERE "grant_id" = ${g.id}::uuid`,
      ).rejects.toThrow(/history/);
      await expect(sql`DELETE FROM "portal_grants" WHERE "id" = ${g.id}::uuid`).rejects.toThrow(
        /history/,
      );
      await revokeRoute(g.id).send({ reason: 'for the revival check' }).expect(200);
      await expect(
        sql`UPDATE "portal_grants" SET "revoked_at" = NULL, "revoked_by" = NULL, "revoke_reason" = NULL WHERE "id" = ${g.id}::uuid`,
      ).rejects.toThrow(/revoked portal grant never changes/);

      const insertGrant = (userId: string, replaces: string | null = null) =>
        t.prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "portal_grants" ("user_id", "payer_customer_id", "granted_by", "reason", "finance_check", "replaces_id")
            VALUES (${userId}::uuid, ${g.payerCustomerId}::uuid, ${userId}::uuid, 'sql', '{}'::jsonb, ${replaces}::uuid)
            RETURNING "id"`;
          return row!.id;
        });
      // No hotel at commit.
      await expect(insertGrant(user.id)).rejects.toThrow(/at least one hotel/);
      const staff = await t.prisma.user.create({
        data: { email: unique('sql-staff'), displayName: 'Staff' },
      });
      await expect(insertGrant(staff.id)).rejects.toThrow(/only for a PORTAL account/);
      // A "replacement" of an active grant (not revoked in the same transaction) is refused.
      const live = await issue(user.id, [hotels[1]!]);
      await expect(insertGrant(user.id, live.id)).rejects.toThrow(/replaces only its own/);
    });

    it('a committed grant is never extended by SQL as the runtime role (review 5817695791 P1)', async () => {
      // This runs as the application's own role, not the owner.
      const [role] = await t.prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT "rolsuper", "rolbypassrls" FROM pg_roles WHERE "rolname" = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const user = await portalAccount();
      const g = await issue(user.id, [hotels[0]!]);
      const scope = () =>
        t.prisma.portalGrantHotel.findMany({ where: { grantId: g.id }, select: { hotelId: true } });
      // The reproduction: a no-op UPDATE (new row version of this transaction), then a late hotel —
      // each committed on its own, and both in one transaction.
      await expect(
        t.prisma
          .$executeRaw`UPDATE "portal_grants" SET "reason" = "reason" WHERE "id" = ${g.id}::uuid`,
      ).rejects.toThrow(/only ever revoked/);
      await expect(
        t.prisma
          .$executeRaw`INSERT INTO "portal_grant_hotels" ("grant_id", "hotel_id") VALUES (${g.id}::uuid, ${hotels[1]}::uuid)`,
      ).rejects.toThrow(/written with the grant/);
      await expect(
        t.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "portal_grants" SET "reason" = "reason" WHERE "id" = ${g.id}::uuid`;
          await tx.$executeRaw`INSERT INTO "portal_grant_hotels" ("grant_id", "hotel_id") VALUES (${g.id}::uuid, ${hotels[1]}::uuid)`;
        }),
      ).rejects.toThrow(/only ever revoked/);
      // A row lock alone does not make the grant the transaction's own either.
      await expect(
        t.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "portal_grants" WHERE "id" = ${g.id}::uuid FOR UPDATE`;
          await tx.$executeRaw`INSERT INTO "portal_grant_hotels" ("grant_id", "hotel_id") VALUES (${g.id}::uuid, ${hotels[1]}::uuid)`;
        }),
      ).rejects.toThrow(/written with the grant/);
      expect(await scope()).toEqual([{ hotelId: hotels[0] }]);
      const row = await t.prisma.portalGrant.findUniqueOrThrow({ where: { id: g.id } });
      expect([row.revokedAt, row.reason]).toEqual([null, 'synthetic portal grant']);
    });
  });

  describe('requestId: a retry gets the same result, written once', () => {
    it('issue: the same request again → the same grant, one row, one audit event; another meaning → IDEMPOTENCY_CONFLICT', async () => {
      const user = await portalAccount();
      const payload = { userId: user.id, ...body([hotels[0]!, hotels[1]!]) };
      const first = await contract('portal-grants').send(payload);
      expect(first.status).toBe(201);
      // The same meaning (hotel order does not matter) after a lost answer.
      const again = await contract('portal-grants').send({
        ...payload,
        hotelIds: [hotels[1]!, hotels[0]!],
        financeCheck: { ...payload.financeCheck, hotelIds: [hotels[1]!, hotels[0]!] },
      });
      expect([again.status, again.body]).toEqual([201, first.body]);
      expect(await written(user.id)).toEqual({ grants: 1, audit: 1 });
      // The same id with another scope, another account or as a replacement → refused.
      for (const other of [
        {
          ...payload,
          ...body([hotels[2]!], payload.payerCustomerId),
          requestId: payload.requestId,
        },
        { ...payload, userId: (await portalAccount()).id },
      ]) {
        const res = await contract('portal-grants').send(other);
        expect([res.status, res.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      }
      const asReplace = await contract(`portal-grants/${first.body.id}/replace`).send({
        ...body([hotels[2]!], payload.payerCustomerId),
        requestId: payload.requestId,
      });
      expect([asReplace.status, asReplace.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      // …and by another administrator.
      const other = await prepareInvitedUser(t, { email: unique('admin-2'), displayName: 'A2' });
      await t.prisma.userRole.create({
        data: { userId: other.id, roleCode: 'ADMIN', grantReason: 'second administrator' },
      });
      const byOther = await contract('portal-grants', await sessionCookie(t, other.email)).send(
        payload,
      );
      expect([byOther.status, byOther.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      expect(await written(user.id)).toEqual({ grants: 1, audit: 1 });
    });

    it('replace: the same request again → the same successor, replaced once; two at once → one write', async () => {
      const user = await portalAccount();
      const old = await issue(user.id, [hotels[0]!]);
      const payload = body([hotels[0]!, hotels[1]!], old.payerCustomerId);
      const [a, b] = await Promise.all([
        contract(`portal-grants/${old.id}/replace`).send(payload),
        contract(`portal-grants/${old.id}/replace`).send(payload),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
      const again = await contract(`portal-grants/${old.id}/replace`).send(payload);
      expect([again.status, again.body]).toEqual([201, a.body]);
      expect(await written(user.id)).toEqual({ grants: 2, audit: 2 });
      expect((await active(user.id)).map((g) => g.id)).toEqual([a.body.id]);
    });
  });

  describe('a replacement that fails after revoking the old grant', () => {
    it('rolls back whole: the old grant and its hotels stay active, no successor, no audit, no request', async () => {
      const marker = `forced failure ${randomUUID()}`;
      // A failure injected into the successor's insert — after the old grant's revocation.
      await withPrivileged(async (db) => {
        await db.$executeRawUnsafe(`
          CREATE FUNCTION test_portal_grant_fail() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test: forced failure after the revocation'; END $$`);
        await db.$executeRawUnsafe(`
          CREATE TRIGGER "test_portal_grant_fail" AFTER INSERT ON "portal_grants"
            FOR EACH ROW WHEN (NEW."reason" = '${marker}') EXECUTE FUNCTION test_portal_grant_fail()`);
      });
      try {
        const user = await portalAccount();
        const old = await issue(user.id, [hotels[0]!]);
        const before = await written(user.id);
        const payload = { ...body([hotels[1]!], old.payerCustomerId), reason: marker };
        const res = await contract(`portal-grants/${old.id}/replace`).send(payload);
        expect(res.status).toBe(500);
        const grant = await t.prisma.portalGrant.findUniqueOrThrow({
          where: { id: old.id },
          include: { hotels: true, replacedBy: true },
        });
        expect([grant.revokedAt, grant.revokeReason, grant.replacedBy]).toEqual([null, null, null]);
        expect(grant.hotels.map((h) => h.hotelId)).toEqual([hotels[0]]);
        expect((await active(user.id)).map((g) => g.id)).toEqual([old.id]);
        expect(await written(user.id)).toEqual(before);
        expect(
          await t.prisma.operationRequest.count({ where: { requestId: payload.requestId } }),
        ).toBe(0);
      } finally {
        await withPrivileged(async (db) => {
          await db.$executeRawUnsafe(`DROP TRIGGER "test_portal_grant_fail" ON "portal_grants"`);
          await db.$executeRawUnsafe(`DROP FUNCTION test_portal_grant_fail()`);
        });
      }
    });
  });
});
