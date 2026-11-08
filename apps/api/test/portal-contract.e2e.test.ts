import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PortalRequestLimit } from '../src/portal/portal-request-limit.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { createHotel } from './support/order-fixtures.js';
import {
  createTestApp,
  hasDatabase,
  TEST_APP_ORIGIN,
  type TestApp,
  withPrivileged,
} from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const portalToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
/** A TOTP code; `offset` picks a neighbouring 30 s step (a used step is never accepted again). */
const otp = (secret: string, offset = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offset,
  });
const client = (
  over: Partial<{ ip: string; origin: string; secFetchSite: string | null }> = {},
) => ({
  ip: '203.0.113.10',
  origin: PORTAL_ORIGIN,
  secFetchSite: 'same-origin',
  ...over,
});

const portalEnv = {
  AUTH_PROVIDER: 'local',
  AUTH_MAIL_DRIVER: 'memory',
  PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
  PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
  FINANCE_SERVICE_TOKEN_SHA256: sha(financeToken),
};

/**
 * The core's hotel portal contract (ADR 0045 §3, §6, §8 on `0d500f6`, PR 3): portal-web's token
 * only, everything as PORTAL, the browser's origin and the sign-in rate limits checked, the scope
 * evaluated from the active grants on every call, a reserved pool and a request limit. Synthetic
 * accounts and hotels only; mail goes to the in-memory test transport.
 */
describe.skipIf(!hasDatabase)('hotel portal contract', () => {
  let t: TestApp;
  let su: TestApp;
  let adminId: string;
  let hotels: string[];

  const core = () => request(t.app.getHttpServer());
  const post = (path: string, token = portalToken) =>
    core().post(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${token}`);
  const get = (path: string, session?: string, token = portalToken) => {
    const r = core().get(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const tokens = () => t.app.get(NativeTokensService);
  const lastMail = async (email: string) => {
    await tokens().deliverPending();
    return tokens()
      .deliveriesForTest()
      .findLast((m) => m.to === email);
  };
  const grant = (userId: string, hotelIds: string[]) =>
    t.app.get(PortalGrantsService).issue(adminId, {
      requestId: randomUUID(),
      userId,
      payerCustomerId: randomUUID(),
      hotelIds,
      reason: 'synthetic portal grant',
      financeCheck: { payerVersionId: randomUUID(), hotelIds, checkedAt: new Date().toISOString() },
    });
  const revoke = (grantId: string) =>
    t.app.get(PortalGrantsService).revoke(adminId, grantId, 'synthetic revocation');

  /** An invited PORTAL account (its link from the test mail). */
  async function invited() {
    const user = await t.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal user', audience: 'PORTAL' },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'synthetic portal invitation', 'PORTAL');
    const mail = await lastMail(user.email);
    expect(mail!.url.startsWith(`${PORTAL_ORIGIN}/activate#token=`)).toBe(true);
    return { user, link: tokenOf(mail!.url) };
  }

  /** A staff account activated on the internal native routes, with its `ayvo_session` cookie. */
  async function staffSession() {
    const user = await t.prisma.user.create({
      data: { email: unique('staff'), displayName: 'Staff' },
    });
    await t.app.get(InvitationsService).send(null, user.id, randomUUID(), 'staff invitation');
    const link = tokenOf((await lastMail(user.email))!.url);
    const native = (path: string) =>
      core().post(`/api/auth/native/${path}`).set('Origin', TEST_APP_ORIGIN);
    const step = await native('activate').send({ token: link, password: PASSWORD }).expect(200);
    const pending = String(step.headers['set-cookie']).match(/ayvo_auth=([^;]+)/)![1]!;
    const done = await native('mfa')
      .set('Cookie', `ayvo_auth=${pending}`)
      .send({ code: otp(String(step.body.setupKey)) })
      .expect(200);
    const token = String(done.headers['set-cookie']).match(/ayvo_session=([^;]+)/)![1]!;
    return { user, token, cookie: `ayvo_session=${token}` };
  }

  /** Activation through the contract: password, TOTP enrolment, a portal session. */
  async function activated() {
    const { user, link } = await invited();
    const step = await post('auth/activate').send({
      token: link,
      password: PASSWORD,
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    expect(step.body.step).toBe('ENROLL_MFA');
    const done = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: otp(step.body.setupKey),
      client: client(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.step).toBe('DONE');
    return { user, secret: step.body.setupKey as string, session: done.body.session as string };
  }

  /** Sign-in through the contract (password, then TOTP of the given step offset). */
  async function signIn(email: string, secret: string, offset: number) {
    const step = await post('auth/password').send({ email, password: PASSWORD, client: client() });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    return { challenge: step.body.challenge as string, code: otp(secret, offset) };
  }

  /** Waits until n backends of this database wait for a lock; returns the count. */
  async function waiters(n: number, exactly = false) {
    for (let i = 0; i < 200; i++) {
      const [row] = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) {
        if (exactly) {
          // Give any further waiter time to appear.
          await new Promise((r) => setTimeout(r, 300));
          const [again] = await t.prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          return again!.n;
        }
        return row!.n;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`fewer than ${n} lock waiters`);
  }

  /** Holds a lock in its own transaction until released. */
  async function holding(
    lock: (tx: { $executeRawUnsafe: (q: string) => Promise<number> }) => Promise<unknown>,
  ) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = withPrivileged((db) =>
      db.$transaction(
        async (tx) => {
          await lock(tx);
          locked();
          await held;
        },
        { timeout: 30_000 },
      ),
    );
    await isLocked;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  beforeAll(async () => {
    t = await createTestApp(portalEnv, {}, { auth: 'real', redis: 'real' });
    su = await createTestApp();
    adminId = (
      await t.prisma.user.create({ data: { email: unique('grant-admin'), displayName: 'Admin' } })
    ).id;
    hotels = [];
    for (const name of ['Hotel Portál 1', 'Hotel Portál 2', 'Hotel Portál 3'])
      hotels.push((await createHotel(su, { name })).id);
  });
  afterAll(async () => {
    await t?.close();
    await su?.close();
  });

  describe('only portal-web, only as PORTAL', () => {
    it('refuses calls without the portal token, with Finance’s token, and the portal token on Finance’s contract', async () => {
      const body = { email: unique('x'), password: PASSWORD, client: client() };
      expect((await core().post('/api/internal/v1/portal/auth/password').send(body)).status).toBe(
        401,
      );
      const finance = await post('auth/password', financeToken).send(body);
      expect([finance.status, finance.body.code]).toEqual([401, 'SERVICE_UNAUTHENTICATED']);
      expect((await get('session', 'x', financeToken)).status).toBe(401);
      const wrong = await core()
        .post('/api/internal/v1/finance/principal')
        .set('Authorization', `Bearer ${portalToken}`)
        .set('x-ayvo-session', 'x')
        .send({ method: 'GET', origin: null, secFetchSite: null });
      expect([wrong.status, wrong.body.code]).toEqual([401, 'SERVICE_UNAUTHENTICATED']);
    });

    it('checks the browser’s origin forwarded by portal-web (no cross-site step)', async () => {
      const body = { email: unique('x'), password: PASSWORD };
      for (const c of [
        client({ origin: 'https://evil.example' }),
        client({ origin: 'https://dev.ayvo.co' }),
        client({ secFetchSite: 'cross-site' }),
        client({ secFetchSite: 'same-site' }),
      ]) {
        const res = await post('auth/password').send({ ...body, client: c });
        expect([res.status, res.body.code], JSON.stringify(c)).toEqual([403, 'CSRF_REJECTED']);
      }
      expect(
        (await post('auth/password').send({ ...body, client: client({ secFetchSite: null }) }))
          .status,
      ).toBe(401);
    });

    it('a staff account, link or session is unknown here — and the reverse', async () => {
      // A staff account with a password and MFA, signed in on the internal OS.
      const staff = await staffSession();
      const pw = await post('auth/password').send({
        email: staff.user.email,
        password: PASSWORD,
        client: client(),
      });
      expect([pw.status, pw.body.code]).toEqual([401, 'INVALID_LOGIN']);
      expect((await get('session', staff.token)).status).toBe(401);
      expect((await core().get('/api/auth/me').set('Cookie', staff.cookie)).status).toBe(200);
      // A staff invitation link on the portal's activation: like an unknown link, unused.
      const fresh = await t.prisma.user.create({
        data: { email: unique('staff-inv'), displayName: 'Staff invite' },
      });
      await t.app.get(InvitationsService).send(null, fresh.id, randomUUID(), 'staff invitation');
      const staffLink = tokenOf((await lastMail(fresh.email))!.url);
      const act = await post('auth/activate').send({
        token: staffLink,
        password: PASSWORD,
        client: client(),
      });
      expect([act.status, act.body.code]).toEqual([400, 'INVALID_LINK']);
      expect(
        await t.prisma.nativeAuthToken.count({
          where: { userId: fresh.id, claimedAt: { not: null } },
        }),
      ).toBe(0);
      // A portal session is no session on the internal OS.
      const portal = await activated();
      expect(
        (await core().get('/api/auth/me').set('Cookie', `ayvo_session=${portal.session}`)).status,
      ).toBe(401);
    });
  });

  describe('activation, sign-in, the session and "Moje hotely"', () => {
    it('shows exactly the granted hotels, evaluated on every call', async () => {
      const { user, session } = await activated();
      expect(user.audience).toBe('PORTAL');
      const empty = await get('session', session);
      expect([empty.status, empty.body.grants]).toEqual([200, []]);
      expect((await get('hotels', session)).body).toEqual([]);

      const g = await grant(user.id, [hotels[0]!, hotels[1]!]);
      const view = await get('session', session).expect(200);
      expect(view.body).toMatchObject({
        user: { id: user.id, email: user.email },
        grants: [{ id: g.id, hotelIds: [hotels[0], hotels[1]].sort() }],
      });
      const mine = await get('hotels', session).expect(200);
      expect(mine.body.map((h: { id: string }) => h.id).sort()).toEqual(
        [hotels[0], hotels[1]].sort(),
      );
      expect((await get(`hotels/${hotels[0]}`, session)).status).toBe(200);
      // Another hotel (existing) or an invented id: not found, alike.
      for (const id of [hotels[2]!, randomUUID()]) {
        const res = await get(`hotels/${id}`, session);
        expect([res.status, res.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
      }
      // A narrowed scope hides on the next call.
      await t.app.get(PortalGrantsService).replace(adminId, g.id, {
        requestId: randomUUID(),
        payerCustomerId: g.payerCustomerId,
        hotelIds: [hotels[1]!],
        reason: 'narrowed',
        financeCheck: {
          payerVersionId: randomUUID(),
          hotelIds: [hotels[1]!],
          checkedAt: new Date().toISOString(),
        },
      });
      expect((await get(`hotels/${hotels[0]}`, session)).status).toBe(404);
      expect((await get('hotels', session)).body.map((h: { id: string }) => h.id)).toEqual([
        hotels[1],
      ]);
    });

    it('signs in with password + TOTP, and logs out', async () => {
      const { user, secret } = await activated();
      const { challenge, code } = await signIn(user.email, secret, 30_000);
      const wrong = await post('auth/mfa').send({ challenge, code: '000000', client: client() });
      expect([wrong.status, wrong.body.code]).toEqual([401, 'INVALID_MFA']);
      const done = await post('auth/mfa').send({ challenge, code, client: client() }).expect(200);
      expect(done.body.step).toBe('DONE');
      const row = await t.prisma.userSession.findFirstOrThrow({
        where: { userId: user.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.audience).toBe('PORTAL');
      await post('auth/logout')
        .set('x-ayvo-portal-session', done.body.session)
        .send({ client: client() })
        .expect(204);
      expect((await get('session', done.body.session)).status).toBe(401);
      // Unknown accounts answer exactly like a wrong password; forgot-password alike.
      const unknown = await post('auth/password').send({
        email: unique('nobody'),
        password: PASSWORD,
        client: client(),
      });
      expect([unknown.status, unknown.body.code]).toEqual([401, 'INVALID_LOGIN']);
      const f1 = await post('auth/forgot-password').send({ email: user.email, client: client() });
      const f2 = await post('auth/forgot-password').send({
        email: unique('nobody'),
        client: client(),
      });
      expect([f1.status, f1.body]).toEqual([f2.status, f2.body]);
      const reset = await lastMail(user.email);
      expect(reset!.url.startsWith(`${PORTAL_ORIGIN}/reset-password#token=`)).toBe(true);
    });
  });

  describe('the last grant removed', () => {
    it('ends the session: the next introspection is 401; signing in again shows nothing (ADR §11)', async () => {
      const { user, secret, session } = await activated();
      const g = await grant(user.id, [hotels[0]!]);
      expect((await get('hotels', session)).body).toHaveLength(1);
      await revoke(g.id);
      expect((await get('session', session)).status).toBe(401);
      expect((await get('hotels', session)).status).toBe(401);
      const { challenge, code } = await signIn(user.email, secret, 30_000);
      const again = await post('auth/mfa').send({ challenge, code, client: client() }).expect(200);
      expect((await get('session', again.body.session)).body.grants).toEqual([]);
      expect((await get('hotels', again.body.session)).body).toEqual([]);
    });

    /**
     * MFA completion and revocation of the last grant at once. Both lock the account's user row,
     * so they serialize; in either order the account ends with no session that sees a hotel.
     */
    it.each(['mfa first', 'revocation first'] as const)(
      'at once with the MFA completion (%s): no session sees a hotel',
      async (order) => {
        const { user, secret, session } = await activated();
        const g = await grant(user.id, [hotels[0]!]);
        const { challenge, code } = await signIn(user.email, secret, 30_000);
        const mfa = () =>
          Promise.resolve(post('auth/mfa').send({ challenge, code, client: client() }));
        const rev = () => revoke(g.id);
        const lock = await holding((tx) =>
          tx.$executeRawUnsafe(`SELECT 1 FROM "users" WHERE "id" = '${user.id}' FOR UPDATE`),
        );
        const first = order === 'mfa first' ? mfa() : rev();
        await waiters(1);
        const second = order === 'mfa first' ? rev() : mfa();
        await waiters(2);
        await lock.release();
        const results = await Promise.all([first, second]);
        const done = (order === 'mfa first' ? results[0] : results[1]) as request.Response;
        expect(done.status).toBe(200);
        // The old session and the new one: neither sees a hotel any more.
        expect((await get('session', session)).status).toBe(401);
        const fresh = await get('hotels', done.body.session);
        if (order === 'mfa first') expect(fresh.status).toBe(401);
        else expect([fresh.status, fresh.body]).toEqual([200, []]);
        const open = await t.prisma.userSession.findMany({
          where: { userId: user.id, revokedAt: null },
        });
        expect(open.length).toBe(order === 'mfa first' ? 0 : 1);
      },
    );
  });

  describe('rate limits (Redis, fail closed)', () => {
    it('limits per account across IPs, and refuses sign-in without Redis', async () => {
      const limited = await createTestApp(
        { ...portalEnv, AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '3' },
        {},
        { auth: 'real', redis: 'real' },
      );
      try {
        const email = unique('limited');
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          const res = await request(limited.app.getHttpServer())
            .post('/api/internal/v1/portal/auth/password')
            .set('Authorization', `Bearer ${portalToken}`)
            .send({ email, password: PASSWORD, client: client({ ip: `198.51.100.${i + 1}` }) });
          statuses.push(res.status);
        }
        expect(statuses).toEqual([401, 401, 401, 429, 429]);
      } finally {
        await limited.close();
      }
      const noRedis = await createTestApp(
        { ...portalEnv, REDIS_URL: 'redis://127.0.0.1:1' },
        {},
        { auth: 'real', redis: 'real' },
      );
      try {
        const res = await request(noRedis.app.getHttpServer())
          .post('/api/internal/v1/portal/auth/password')
          .set('Authorization', `Bearer ${portalToken}`)
          .send({ email: unique('x'), password: PASSWORD, client: client() });
        expect([res.status, res.body.code]).toEqual([503, 'AUTH_UNAVAILABLE']);
      } finally {
        await noRedis.close();
      }
    });

    it('without a configured portal origin the contract refuses every step (503)', async () => {
      const bare = await createTestApp(
        { ...portalEnv, PORTAL_PUBLIC_ORIGIN: '' },
        {},
        { auth: 'real', redis: 'real' },
      );
      try {
        const res = await request(bare.app.getHttpServer())
          .post('/api/internal/v1/portal/auth/password')
          .set('Authorization', `Bearer ${portalToken}`)
          .send({ email: unique('x'), password: PASSWORD, client: client() });
        expect([res.status, res.body.code]).toEqual([503, 'PORTAL_NOT_CONFIGURED']);
      } finally {
        await bare.close();
      }
    });
  });

  describe('reserved pool and request limit (ADR §8)', () => {
    it('held portal requests use only the portal pool and slots; the rest 503 at once; staff work is unaffected; nothing leaks', async () => {
      const { user, session } = await activated();
      await grant(user.id, [hotels[0]!]);
      const staffCookie = (await staffSession()).cookie;
      const limit = t.app.get(PortalRequestLimit);
      expect(limit.inFlight).toBe(0);

      // Every portal read of the grants waits behind this lock.
      const lock = await holding((tx) =>
        tx.$executeRawUnsafe(`LOCK TABLE "portal_grants" IN ACCESS EXCLUSIVE MODE`),
      );
      let held: Promise<request.Response>[] = [];
      try {
        held = Array.from({ length: 8 }, () => Promise.resolve(get('session', session)));
        // Only the portal pool's 2 connections reach the database and wait there.
        expect(await waiters(2, true)).toBe(2);
        for (let i = 0; i < 20 && limit.inFlight < 8; i++)
          await new Promise((r) => setTimeout(r, 25));
        expect(limit.inFlight).toBe(8);
        // Further portal requests: 503 at once.
        const started = Date.now();
        const busy = await Promise.all([get('session', session), get('hotels', session)]);
        expect(busy.map((r) => [r.status, r.body.code])).toEqual([
          [503, 'PORTAL_BUSY'],
          [503, 'PORTAL_BUSY'],
        ]);
        expect(Date.now() - started).toBeLessThan(1000);
        // Staff work on the core completes meanwhile, on its own pool.
        const before = Date.now();
        const me = await core().get('/api/auth/me').set('Cookie', staffCookie);
        expect(me.status).toBe(200);
        expect(Date.now() - before).toBeLessThan(2000);
      } finally {
        await lock.release();
      }
      const answers = await Promise.all(held);
      expect(answers.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(limit.inFlight).toBe(0);

      // Aborted portal requests (the client gives up while they wait) leak no slot.
      const again = await holding((tx) =>
        tx.$executeRawUnsafe(`LOCK TABLE "portal_grants" IN ACCESS EXCLUSIVE MODE`),
      );
      try {
        const aborted = Array.from({ length: 8 }, () =>
          Promise.resolve(get('session', session).timeout(150)).catch(() => 'aborted'),
        );
        expect(await Promise.all(aborted)).toEqual(Array(8).fill('aborted'));
      } finally {
        await again.release();
      }
      for (let i = 0; i < 100 && limit.inFlight > 0; i++)
        await new Promise((r) => setTimeout(r, 25));
      expect(limit.inFlight).toBe(0);
      const after = await Promise.all(
        Array.from({ length: 8 }, () => Promise.resolve(get('session', session))),
      );
      expect(after.map((r) => r.status)).toEqual(Array(8).fill(200));
    });
  });
});
