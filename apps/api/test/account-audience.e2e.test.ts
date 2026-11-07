import { randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeAuthService } from '../src/identity/native-auth.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PrincipalResolver } from '../src/identity/principal-resolver.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import {
  createTestApp,
  hasDatabase,
  TEST_APP_ORIGIN,
  type TestApp,
  withPrivileged,
} from './support/test-app.js';

const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const PORTAL_ORIGIN = 'https://portal.example.test';
/** A TOTP code; `offset` picks a neighbouring 30 s step (a used step is never accepted again). */
const otp = (secret: string, offset = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offset,
  });
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;

/**
 * Hotel portal PR 1 (ADR 0045 §2 on `0d500f6`): every account, role, session, one-time token and
 * pre-session challenge belongs to one audience, STAFF or PORTAL — in the database and in every
 * service step. The portal's own routes come in a later PR; a PORTAL account is driven here
 * through the services with `audience: 'PORTAL'`, exactly as that contract will call them.
 * Synthetic accounts only; mail goes to the in-memory test transport.
 */
describe.skipIf(!hasDatabase)('account audience: STAFF and PORTAL never mix', () => {
  let t: TestApp;
  let su: TestApp;
  /** An administrator's app (superuser principal) with a configured portal origin. */
  let adm: TestApp;
  const http = () => request(t.app.getHttpServer());
  const post = (path: string) =>
    http().post(`/api/auth/native/${path}`).set('Origin', TEST_APP_ORIGIN);
  const auth = () => t.app.get(NativeAuthService);
  const mails = () => t.app.get(NativeTokensService).deliveriesForTest();
  const lastMail = async (email: string) => {
    await t.app.get(NativeTokensService).deliverPending();
    return mails().findLast((m) => m.to === email);
  };

  /** An invited account of this audience (the users table takes the audience at creation). */
  async function invited(audience: 'STAFF' | 'PORTAL') {
    const user = await t.prisma.user.create({
      data: {
        email: `${audience.toLowerCase()}-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: `Audience ${audience}`,
        audience,
      },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'synthetic audience test', audience);
    const mail = await lastMail(user.email);
    expect(mail, user.email).toBeTruthy();
    return { user, link: mail!.url, token: tokenOf(mail!.url) };
  }

  /** A PORTAL account activated through the services as PORTAL, with its portal session token. */
  async function portalAccount() {
    const { user, link, token } = await invited('PORTAL');
    const step = await auth().beginAction('ENROLL', token, PASSWORD, 'PORTAL');
    expect(step?.enrollmentUri).toBeTruthy();
    const secret = new URL(step!.enrollmentUri!).searchParams.get('secret')!;
    const done = await auth().complete(step!.token, otp(secret), 'PORTAL');
    expect(done.kind).toBe('ok');
    return { user, link, secret, session: (done as { token: string }).token };
  }

  beforeAll(async () => {
    t = await createTestApp(
      { AUTH_PROVIDER: 'local', AUTH_MAIL_DRIVER: 'memory', PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN },
      {},
      { auth: 'real', redis: 'real' },
    );
    su = await createTestApp();
    adm = await createTestApp({
      AUTH_PROVIDER: 'local',
      AUTH_MAIL_DRIVER: 'memory',
      PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
    });
  });
  afterAll(async () => {
    await t?.close();
    await su?.close();
    await adm?.close();
  });

  describe('the catalogue and the accounts (database)', () => {
    it('HOTEL_USER is the one PORTAL role; every other role is STAFF', async () => {
      const roles = await t.prisma.role.findMany({ select: { code: true, audience: true } });
      expect(roles.filter((r) => r.audience === 'PORTAL').map((r) => r.code)).toEqual([
        'HOTEL_USER',
      ]);
      expect(roles.length).toBeGreaterThan(1);
    });

    it('an audience never changes; a custom role is never PORTAL', async () => {
      const user = await t.prisma.user.create({
        data: { email: `fixed-${randomUUID().slice(0, 8)}@ayvo.test`, displayName: 'Fixed' },
      });
      expect(user.audience).toBe('STAFF');
      await expect(
        t.prisma
          .$executeRaw`UPDATE "users" SET "audience" = 'PORTAL' WHERE "id" = ${user.id}::uuid`,
      ).rejects.toThrow(/audience never changes/);
      await expect(
        t.prisma.$executeRaw`INSERT INTO "roles" ("code", "name", "description", "audience")
          VALUES (${`X_${randomUUID().slice(0, 6).toUpperCase()}`}, 'Hotelová', 'test', 'PORTAL')`,
      ).rejects.toThrow(/only HOTEL_USER is a PORTAL role/);
    });

    it('a role audience never changes — also with the catalogue flag on, as the runtime role or the owner', async () => {
      // Any session can set the flag; it lets roles_guard through, never the audience rule.
      const flagged = (db: typeof t.prisma, sql: string) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('ayvo.catalogue_migration', 'on', true)`;
          await tx.$executeRawUnsafe(sql);
        });
      for (const sql of [
        `UPDATE "roles" SET "audience" = 'STAFF' WHERE "code" = 'HOTEL_USER'`,
        `UPDATE "roles" SET "audience" = 'PORTAL' WHERE "code" = 'ADMIN'`,
        `UPDATE "roles" SET "audience" = 'PORTAL' WHERE "code" = 'WAREHOUSE_SUPERVISOR'`,
      ]) {
        await expect(flagged(t.prisma, sql), `ayvo_core: ${sql}`).rejects.toThrow(
          /only HOTEL_USER is a PORTAL role|audience never changes/,
        );
        await expect(
          withPrivileged((db) => flagged(db as unknown as typeof t.prisma, sql)),
          `owner: ${sql}`,
        ).rejects.toThrow(/only HOTEL_USER is a PORTAL role|audience never changes/);
      }
      // A system role inserted under the flag as PORTAL (anything but HOTEL_USER) is refused too.
      await expect(
        flagged(
          t.prisma,
          `INSERT INTO "roles" ("code", "name", "description", "is_system", "audience")
           VALUES ('X_PORTAL_SYSTEM', 'X', 'test', true, 'PORTAL')`,
        ),
      ).rejects.toThrow(/only HOTEL_USER is a PORTAL role/);
      const roles = await t.prisma.role.findMany({ select: { code: true, audience: true } });
      expect(roles.filter((r) => r.audience === 'PORTAL').map((r) => r.code)).toEqual([
        'HOTEL_USER',
      ]);
    });
  });

  describe('roles only for their own audience', () => {
    it('the database refuses a role of the other audience, also as two concurrent grants', async () => {
      const staff = await t.prisma.user.create({
        data: { email: `s-${randomUUID().slice(0, 8)}@ayvo.test`, displayName: 'S' },
      });
      const portal = await t.prisma.user.create({
        data: {
          email: `p-${randomUUID().slice(0, 8)}@ayvo.test`,
          displayName: 'P',
          audience: 'PORTAL',
        },
      });
      const grant = (userId: string, role: string) =>
        t.prisma.$executeRaw`INSERT INTO "user_roles" ("user_id", "role_code", "grant_reason")
          VALUES (${userId}::uuid, ${role}, 'audience test')`;
      await expect(grant(staff.id, 'HOTEL_USER')).rejects.toThrow(
        /a PORTAL role is never granted to a STAFF account/,
      );
      await expect(grant(portal.id, 'ADMIN')).rejects.toThrow(
        /a STAFF role is never granted to a PORTAL account/,
      );
      // Two grants to one account at once: both take the user row lock first; the STAFF role is
      // granted, the PORTAL one refused — never both.
      const [a, b] = await Promise.allSettled([
        grant(staff.id, 'WAREHOUSE_SUPERVISOR'),
        grant(staff.id, 'HOTEL_USER'),
      ]);
      expect([a.status, b.status]).toEqual(['fulfilled', 'rejected']);
      const open = await t.prisma.userRole.findMany({
        where: { userId: staff.id, revokedAt: null },
        select: { roleCode: true },
      });
      expect(open.map((r) => r.roleCode)).toEqual(['WAREHOUSE_SUPERVISOR']);
    });

    it('the API refuses an internal role for a portal account (ROLE_AUDIENCE_MISMATCH)', async () => {
      const portal = await su.prisma.user.create({
        data: {
          email: `pa-${randomUUID().slice(0, 8)}@ayvo.test`,
          displayName: 'PA',
          audience: 'PORTAL',
        },
      });
      const res = await request(su.app.getHttpServer())
        .post(`/api/admin/identity/users/${portal.id}/roles/grant`)
        .send({ role: 'WAREHOUSE_SUPERVISOR', reason: 'audience test' });
      expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([
        409,
        'ROLE_AUDIENCE_MISMATCH',
      ]);
      expect(await su.prisma.userRole.count({ where: { userId: portal.id } })).toBe(0);
    });
  });

  describe('sessions only on their own side', () => {
    it('a portal session is no session on the internal OS, its API or its internal contract', async () => {
      const portal = await portalAccount();
      const row = await t.prisma.userSession.findFirstOrThrow({
        where: { userId: portal.user.id, revokedAt: null },
      });
      expect(row.audience).toBe('PORTAL');
      const cookie = `ayvo_session=${portal.session}`;
      expect((await http().get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
      expect((await http().get('/api/admin/identity/users').set('Cookie', cookie)).status).toBe(
        401,
      );
      // The internal contract (Finance's staff path forwards the session to this resolver).
      expect(await t.app.get(PrincipalResolver).resolveToken(portal.session)).toEqual({
        kind: 'anonymous',
      });
      // …while it is a valid session on its own side, untouched by those attempts.
      const own = await t.app.get(SessionsService).lookup(portal.session, 'PORTAL');
      expect(own.kind).toBe('active');
      expect(
        (await t.prisma.userSession.findUniqueOrThrow({ where: { id: row.id } })).revokedAt,
      ).toBeNull();
    });

    it('a staff session is no session on the portal side', async () => {
      const { user, token } = await invited('STAFF');
      const step = await post('activate').send({ token, password: PASSWORD }).expect(200);
      const pending = String(step.headers['set-cookie']).match(/ayvo_auth=([^;]+)/)![1]!;
      const done = await post('mfa')
        .set('Cookie', `ayvo_auth=${pending}`)
        .send({ code: otp(String(step.body.setupKey)) })
        .expect(200);
      const session = String(done.headers['set-cookie']).match(/ayvo_session=([^;]+)/)![1]!;
      expect((await t.app.get(SessionsService).lookup(session, 'PORTAL')).kind).toBe('none');
      expect((await t.app.get(SessionsService).lookup(session, 'STAFF')).kind).toBe('active');
      expect(user.audience).toBe('STAFF');
    });

    it('the database refuses a session, token or challenge of another audience than its user', async () => {
      const portal = await t.prisma.user.create({
        data: {
          email: `db-${randomUUID().slice(0, 8)}@ayvo.test`,
          displayName: 'DB',
          audience: 'PORTAL',
        },
      });
      const identity = await t.prisma.userIdentity.create({
        data: {
          userId: portal.id,
          provider: 'LOCAL',
          subject: portal.id,
          emailAtLink: portal.email,
        },
      });
      const later = new Date(Date.now() + 3_600_000);
      await expect(
        t.prisma.userSession.create({
          data: {
            tokenSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
            userId: portal.id,
            identityId: identity.id,
            idleExpiresAt: later,
            absoluteExpiresAt: later,
            audience: 'STAFF',
          },
        }),
      ).rejects.toThrow(/user_sessions belongs to its user's audience/);
      await expect(
        t.prisma.nativeAuthChallenge.create({
          data: {
            userId: portal.id,
            tokenSha256: randomUUID().replace(/-/g, '').padEnd(64, '1'),
            kind: 'LOGIN',
            credentialRevision: 0,
            expiresAt: later,
            audience: 'STAFF',
          },
        }),
      ).rejects.toThrow(/native_auth_challenges belongs to its user's audience/);
      await expect(
        t.prisma.nativeAuthToken.create({
          data: {
            userId: portal.id,
            purpose: 'RESET_PASSWORD',
            tokenSha256: randomUUID().replace(/-/g, '').padEnd(64, '2'),
            credentialRevision: 0,
            expiresAt: later,
            audience: 'STAFF',
          },
        }),
      ).rejects.toThrow(/native_auth_tokens belongs to its user's audience/);
    });
  });

  describe('one-time tokens and the password → MFA step only on their own side', () => {
    it('a portal invitation link points to the portal origin; the staff route refuses it and leaves it unused', async () => {
      const { user, link, token } = await invited('PORTAL');
      expect(link.startsWith(`${PORTAL_ORIGIN}/activate#token=`)).toBe(true);
      const res = await post('activate').send({ token, password: PASSWORD });
      expect([res.status, res.body.code]).toEqual([400, 'INVALID_LINK']);
      const row = await t.prisma.nativeAuthToken.findFirstOrThrow({
        where: { userId: user.id, purpose: 'ENROLL' },
      });
      expect([row.audience, row.claimedAt, row.usedAt]).toEqual(['PORTAL', null, null]);
      expect(await t.prisma.nativeAuthChallenge.count({ where: { userId: user.id } })).toBe(0);
      // …and the same link works on its own side.
      expect(await auth().beginAction('ENROLL', token, PASSWORD, 'PORTAL')).not.toBeNull();
    });

    it('a staff invitation is refused on the portal side and left unused', async () => {
      const { user, link, token } = await invited('STAFF');
      expect(link.startsWith(`${TEST_APP_ORIGIN}/activate#token=`)).toBe(true);
      expect(await auth().beginAction('ENROLL', token, PASSWORD, 'PORTAL')).toBeNull();
      const row = await t.prisma.nativeAuthToken.findFirstOrThrow({
        where: { userId: user.id, purpose: 'ENROLL' },
      });
      expect([row.claimedAt, row.usedAt]).toEqual([null, null]);
    });

    it('forgot-password of the other audience creates no token and sends no mail; links never follow a request header', async () => {
      const portal = await portalAccount();
      const before = mails().length;
      const tokens = await t.prisma.nativeAuthToken.count({ where: { userId: portal.user.id } });
      const res = await post('forgot-password')
        .set('X-Forwarded-Host', 'evil.example')
        .send({ email: portal.user.email })
        .expect(200);
      expect(res.body.message).toMatch(/Pokud má tento e-mail aktivní účet/);
      await t.app.get(NativeTokensService).deliverPending();
      expect(mails().length).toBe(before);
      expect(await t.prisma.nativeAuthToken.count({ where: { userId: portal.user.id } })).toBe(
        tokens,
      );
      // The same request for a staff account: one mail, whose link is the configured staff origin
      // whatever host the request named.
      const staff = await invited('STAFF');
      const step = await post('activate').send({ token: staff.token, password: PASSWORD });
      const pending = String(step.headers['set-cookie']).match(/ayvo_auth=([^;]+)/)![1]!;
      await post('mfa')
        .set('Cookie', `ayvo_auth=${pending}`)
        .send({ code: otp(String(step.body.setupKey)) })
        .expect(200);
      await post('forgot-password')
        .set('Host', 'evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .send({ email: staff.user.email })
        .expect(200);
      const reset = await lastMail(staff.user.email);
      expect(reset!.url.startsWith(`${TEST_APP_ORIGIN}/reset-password#token=`)).toBe(true);
      // A portal reset (its own side) points to the portal origin.
      await auth().requestPasswordReset(portal.user.email, 'PORTAL');
      const portalReset = await lastMail(portal.user.email);
      expect(portalReset!.url.startsWith(`${PORTAL_ORIGIN}/reset-password#token=`)).toBe(true);
      // …and that reset token is refused by the staff route, unused.
      const refused = await post('reset-password').send({
        token: tokenOf(portalReset!.url),
        password: PASSWORD,
      });
      expect([refused.status, refused.body.code]).toEqual([400, 'INVALID_LINK']);
    });

    it('the password step of the other audience creates no challenge; a challenge is not even counted on the other side', async () => {
      const portal = await portalAccount();
      const challenges = () =>
        t.prisma.nativeAuthChallenge.count({ where: { userId: portal.user.id } });
      const before = await challenges();
      const res = await post('password').send({
        email: portal.user.email,
        password: PASSWORD,
        next: '/',
      });
      expect(res.status).toBe(401);
      expect(await challenges()).toBe(before);
      // The portal's own password step creates a PORTAL challenge…
      const begun = await auth().beginLogin(portal.user.email, PASSWORD, '/', 'PORTAL');
      expect(begun).not.toBeNull();
      const row = await t.prisma.nativeAuthChallenge.findFirstOrThrow({
        where: { userId: portal.user.id, usedAt: null, kind: 'LOGIN' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.audience).toBe('PORTAL');
      // …which the staff MFA route refuses without counting an attempt…
      const mfa = await post('mfa')
        .set('Cookie', `ayvo_auth=${begun!.token}`)
        .send({ code: otp(portal.secret) });
      expect(mfa.status).toBe(401);
      const after = await t.prisma.nativeAuthChallenge.findUniqueOrThrow({ where: { id: row.id } });
      expect([after.attempts, after.usedAt]).toEqual([0, null]);
      // …and it is completed on its own side: a PORTAL session.
      const done = await auth().complete(begun!.token, otp(portal.secret, 30_000), 'PORTAL');
      expect(done.kind).toBe('ok');
      expect(
        (await t.app.get(SessionsService).lookup((done as { token: string }).token, 'PORTAL')).kind,
      ).toBe('active');
    });
  });

  it('the internal invitation routes refuse a portal account: no request, invitation, token or mail', async () => {
    // A PORTAL account with an open invitation of its own side (issued as the portal path will).
    const { user } = await invited('PORTAL');
    const state = async () => ({
      invitations: await adm.prisma.userInvitation.findMany({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      }),
      requests: await adm.prisma.userInvitationRequest.count({
        where: { invitation: { userId: user.id } },
      }),
      tokens: await adm.prisma.nativeAuthToken.findMany({
        where: { userId: user.id },
        select: { id: true, tokenSha256: true, revision: true, sentAt: true, revokedAt: true },
        orderBy: { id: 'asc' },
      }),
    });
    const before = await state();
    expect(before.tokens).toHaveLength(1);
    const mailsTo = () =>
      adm.app
        .get(NativeTokensService)
        .deliveriesForTest()
        .filter((m) => m.to === user.email).length;
    const http = request(adm.app.getHttpServer());
    for (const action of ['', '/resend', '/revoke']) {
      const res = await http
        .post(`/api/admin/identity/users/${user.id}/invitations${action}`)
        .send({ requestId: randomUUID(), reason: 'internal invitation of a portal account' });
      expect([res.status, res.body.code], `invitations${action}`).toEqual([
        409,
        'ACCOUNT_AUDIENCE_MISMATCH',
      ]);
    }
    await adm.app.get(NativeTokensService).deliverPending();
    await t.app.get(NativeTokensService).deliverPending();
    expect(await state()).toEqual(before);
    expect(mailsTo()).toBe(0);

    // A request id first used on the portal side (a SEND) is not resumed by the internal SEND route.
    const portalRequest = await adm.prisma.userInvitationRequest.findFirstOrThrow({
      where: { invitation: { userId: user.id } },
    });
    const replay = await http
      .post(`/api/admin/identity/users/${user.id}/invitations`)
      .send({ requestId: portalRequest.requestId, reason: 'replay of a portal request id' });
    expect(portalRequest.kind).toBe('SEND');
    expect([replay.status, replay.body.code]).toEqual([409, 'ACCOUNT_AUDIENCE_MISMATCH']);
    expect(await state()).toEqual(before);

    // An ordinary STAFF invitation through the same route goes through, to the staff origin.
    const staff = await adm.prisma.user.create({
      data: { email: `inv-${randomUUID().slice(0, 8)}@ayvo.test`, displayName: 'Staff invite' },
    });
    await http
      .post(`/api/admin/identity/users/${staff.id}/invitations`)
      .send({ requestId: randomUUID(), reason: 'staff invitation' })
      .expect(200);
    await adm.app.get(NativeTokensService).deliverPending();
    const sent = adm.app
      .get(NativeTokensService)
      .deliveriesForTest()
      .findLast((m) => m.to === staff.email);
    expect(sent?.url.startsWith(`${TEST_APP_ORIGIN}/activate#token=`)).toBe(true);
  });

  it('without a configured portal origin no portal link is issued (fail closed)', async () => {
    // The superuser app has no PORTAL_PUBLIC_ORIGIN.
    const portal = await su.prisma.user.create({
      data: {
        email: `noorigin-${randomUUID().slice(0, 8)}@ayvo.test`,
        displayName: 'No origin',
        audience: 'PORTAL',
      },
    });
    await su.app
      .get(InvitationsService)
      .send(null, portal.id, randomUUID(), 'no portal origin', 'PORTAL')
      .catch(() => undefined);
    expect(await su.prisma.nativeAuthToken.count({ where: { userId: portal.id } })).toBe(0);
  });
});
