import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { Secret, TOTP } from 'otpauth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRateLimitService } from '../src/identity/auth-rate-limit.service.js';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

const PASSWORD = 'Dlouhe vlastni heslo AYVO 123';
const NEW_PASSWORD = 'Jine dlouhe heslo AYVO 456';
const cookies = (response: Response, name: string) => {
  const raw = response.headers['set-cookie'] as string[] | undefined;
  const value = raw?.find((part) => part.startsWith(`${name}=`));
  expect(value, `missing ${name}`).toBeTruthy();
  return value!.split(';')[0]!;
};
const otp = (secret: string, offset = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offset,
  });

describe.skipIf(!hasDatabase)('native authentication through HTTP, PostgreSQL and Redis', () => {
  let t: TestApp;
  let clock = Date.now() + 60_000;
  const http = () => request(t.app.getHttpServer());
  const post = (path: string) =>
    http().post(`/api/auth/native/${path}`).set('Origin', TEST_APP_ORIGIN);
  beforeAll(async () => {
    t = await createTestApp(
      { AUTH_PROVIDER: 'local', AUTH_MAIL_DRIVER: 'memory' },
      {},
      { auth: 'real', redis: 'real' },
    );
  });
  afterAll(() => t?.close());
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock += 60_000;
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function prepared() {
    const user = await t.prisma.user.create({
      data: { email: `native-${randomUUID()}@ayvo.test`, displayName: 'Native Test' },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'Synthetic native authentication test');
    await t.app.get(NativeTokensService).deliverPending();
    const delivery = t.app
      .get(NativeTokensService)
      .deliveriesForTest()
      .findLast((mail) => mail.to === user.email)!;
    expect(delivery).toBeTruthy();
    const token = new URLSearchParams(new URL(delivery.url).hash.slice(1)).get('token')!;
    const setup = await post('activate').send({ token, password: PASSWORD }).expect(200);
    expect(setup.body.step).toBe('ENROLL_MFA');
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = String(setup.body.setupKey);
    return { user, secret, pending: cookies(setup, 'ayvo_auth'), activationToken: token };
  }

  async function activated() {
    const item = await prepared();
    const done = await post('mfa')
      .set('Cookie', item.pending)
      .send({ code: otp(item.secret, -30_000) })
      .expect(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    return {
      ...item,
      session: cookies(done, 'ayvo_session'),
      recoveryCodes: done.body.recoveryCodes as string[],
    };
  }

  async function password(email: string, value = PASSWORD) {
    const result = await post('password')
      .send({ email, password: value, next: '/sales' })
      .expect(200);
    expect(result.body).toEqual({ step: 'MFA' });
    expect(String(result.headers['set-cookie'])).not.toMatch(/ayvo_session=/);
    return cookies(result, 'ayvo_auth');
  }

  it('requires actual MFA enrollment before creating any credential, identity or session', async () => {
    const item = await prepared();
    expect(
      await t.prisma.nativeCredential.findUnique({ where: { userId: item.user.id } }),
    ).toBeNull();
    await http().get('/api/auth/me').set('Cookie', item.pending).expect(401);
    expect(await t.prisma.userSession.count({ where: { userId: item.user.id } })).toBe(0);
    const done = await post('mfa')
      .set('Cookie', item.pending)
      .send({ code: otp(item.secret) })
      .expect(200);
    const session = cookies(done, 'ayvo_session');
    expect(String(done.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(done.headers['set-cookie'])).toContain('Secure');
    await http().get('/api/auth/me').set('Cookie', session).expect(200);
    const stored = await t.prisma.nativeCredential.findUniqueOrThrow({
      where: { userId: item.user.id },
    });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.totpCiphertext).not.toContain(item.secret);
    expect(await t.prisma.userRole.count({ where: { userId: item.user.id } })).toBe(0);
    expect(
      (await t.prisma.userInvitation.findFirstOrThrow({ where: { userId: item.user.id } })).state,
    ).toBe('ACCEPTED');
    expect(
      (await t.prisma.nativeAuthToken.findFirstOrThrow({ where: { userId: item.user.id } }))
        .deliveryCiphertext,
    ).toBeNull();
  });

  it('uses a local two-step login and gives indistinguishable wrong-password/unknown-user answers', async () => {
    const item = await activated();
    const wrong = await post('password')
      .send({ email: item.user.email, password: 'wrong' })
      .expect(401);
    const unknown = await post('password')
      .send({ email: `absent-${randomUUID()}@ayvo.test`, password: 'wrong' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    const pending = await password(item.user.email);
    await http().get('/api/auth/me').set('Cookie', pending).expect(401);
    const done = await post('mfa')
      .set('Cookie', pending)
      .send({ code: otp(item.secret) })
      .expect(200);
    expect(done.body.nextPath).toBe('/sales');
    expect(done.body.recoveryCodes).toBeUndefined();
    await http().get('/api/auth/me').set('Cookie', cookies(done, 'ayvo_session')).expect(200);
    await http().get('/api/auth/callback?code=anything&state=anything').expect(404);
    const local = await http().get('/api/auth/login').expect(302);
    expect(local.headers.location).toMatch(/^\/login\?/);
  });

  it('persists failed factor attempts and closes the challenge after five guesses', async () => {
    const item = await activated();
    const pending = await password(item.user.email);
    for (let index = 0; index < 5; index++)
      await post('mfa').set('Cookie', pending).send({ code: 'bad-code' }).expect(401);
    await post('mfa')
      .set('Cookie', pending)
      .send({ code: otp(item.secret) })
      .expect(401);
    const row = await t.prisma.nativeAuthChallenge.findFirstOrThrow({
      where: { userId: item.user.id, kind: 'LOGIN' },
    });
    expect(row.attempts).toBe(5);
  });

  it('consumes one challenge once under concurrent correct responses', async () => {
    const item = await activated();
    const pending = await password(item.user.email);
    const before = await t.prisma.userSession.count({ where: { userId: item.user.id } });
    const results = await Promise.all(
      [0, 1].map(() =>
        post('mfa')
          .set('Cookie', pending)
          .send({ code: otp(item.secret) }),
      ),
    );
    expect(results.map((value) => value.status).sort()).toEqual([200, 401]);
    expect(await t.prisma.userSession.count({ where: { userId: item.user.id } })).toBe(before + 1);
  });

  it('rejects the same TOTP step across two separately valid password challenges', async () => {
    const item = await activated();
    const a = await password(item.user.email);
    const b = await password(item.user.email);
    const results = await Promise.all(
      [a, b].map((pending) =>
        post('mfa')
          .set('Cookie', pending)
          .send({ code: otp(item.secret) }),
      ),
    );
    expect(results.map((value) => value.status).sort()).toEqual([200, 401]);
  });

  it('will not finish an expired challenge or one belonging to a deactivated account', async () => {
    const item = await activated();
    const pending = await password(item.user.email);
    // Advance the application's clock instead of creating an impossible DB timestamp
    // (expires_at must remain later than the DB-owned created_at).
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await post('mfa')
      .set('Cookie', pending)
      .send({ code: otp(item.secret) })
      .expect(401);
    const another = await password(item.user.email);
    await t.prisma.user.update({
      where: { id: item.user.id },
      data: {
        status: 'DEACTIVATED',
        deactivatedAt: new Date(),
        deactivatedBy: item.user.id,
        deactivationReason: 'Synthetic deactivation',
      },
    });
    await post('mfa')
      .set('Cookie', another)
      .send({ code: otp(item.secret) })
      .expect(401);
  });

  it('rejects an activation revoked after its password/setup stage', async () => {
    const item = await prepared();
    const action = await t.prisma.nativeAuthToken.findFirstOrThrow({
      where: { userId: item.user.id },
    });
    await t.prisma.nativeAuthToken.update({
      where: { id: action.id },
      data: { revokedAt: new Date() },
    });
    await post('mfa')
      .set('Cookie', item.pending)
      .send({ code: otp(item.secret) })
      .expect(401);
    expect(
      await t.prisma.nativeCredential.findUnique({ where: { userId: item.user.id } }),
    ).toBeNull();
  });

  it('cannot repurpose an activation link as a password reset or reuse an already-claimed link', async () => {
    const item = await prepared();
    await post('reset-password')
      .send({ token: item.activationToken, password: NEW_PASSWORD })
      .expect(400);
    await post('activate').send({ token: item.activationToken, password: PASSWORD }).expect(400);
    await post('mfa')
      .set('Cookie', item.pending)
      .send({ code: otp(item.secret) })
      .expect(200);
    await post('activate').send({ token: item.activationToken, password: PASSWORD }).expect(400);
  });

  it('keeps MFA on password reset, then revokes old sessions and all stale password challenges', async () => {
    const item = await activated();
    const stale = await password(item.user.email);
    const known = await post('forgot-password').send({ email: item.user.email }).expect(200);
    const unknown = await post('forgot-password')
      .send({ email: `unknown-${randomUUID()}@ayvo.test` })
      .expect(200);
    expect(known.body).toEqual(unknown.body);
    await t.app.get(NativeTokensService).deliverPending();
    const delivery = t.app
      .get(NativeTokensService)
      .deliveriesForTest()
      .findLast((value) => value.to === item.user.email)!;
    const token = new URLSearchParams(new URL(delivery.url).hash.slice(1)).get('token')!;
    const reset = await post('reset-password').send({ token, password: NEW_PASSWORD }).expect(200);
    const pending = cookies(reset, 'ayvo_auth');
    await post('mfa').set('Cookie', pending).send({ code: 'not-a-code' }).expect(401);
    await http().get('/api/auth/me').set('Cookie', item.session).expect(200);
    const done = await post('mfa')
      .set('Cookie', pending)
      .send({ code: otp(item.secret) })
      .expect(200);
    expect(done.body.step).toBe('PASSWORD_RESET');
    expect(String(done.headers['set-cookie'])).toContain('ayvo_session=;');
    await http().get('/api/auth/me').set('Cookie', item.session).expect(401);
    await post('mfa')
      .set('Cookie', stale)
      .send({ code: otp(item.secret) })
      .expect(401);
    await post('password').send({ email: item.user.email, password: PASSWORD }).expect(401);
    await password(item.user.email, NEW_PASSWORD);
    expect(
      (await t.prisma.nativeCredential.findUniqueOrThrow({ where: { userId: item.user.id } }))
        .mfaRevision,
    ).toBe(1);
    // One request, one entry of the new password: the audit does not report a second request.
    const audit = await t.prisma.auditEvent.findMany({
      where: { targetUserId: item.user.id, type: { startsWith: 'PASSWORD_RESET' } },
      select: { type: true },
    });
    expect(audit.map((a) => a.type).sort()).toEqual([
      'PASSWORD_RESET_COMPLETED',
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_STARTED',
    ]);
  });

  it('keeps no encrypted link after delivery and purges expired one-time material', async () => {
    const item = await prepared();
    const sent = await t.prisma.nativeAuthToken.findFirstOrThrow({
      where: { userId: item.user.id, purpose: 'ENROLL' },
    });
    expect(sent.sentAt).not.toBeNull();
    expect(sent.deliveryCiphertext).toBeNull();
    // The open setup stage holds the chosen password hash and new MFA seed until it expires.
    const stage = await t.prisma.nativeAuthChallenge.findFirstOrThrow({
      where: { userId: item.user.id, kind: 'ENROLL' },
    });
    expect(stage.passwordHash).not.toBeNull();
    expect(stage.totpCiphertext).not.toBeNull();
    // An undelivered link that expires loses its mail copy; the expired stage is closed.
    const queued = await t.prisma.user.create({
      data: { email: `native-${randomUUID()}@ayvo.test`, displayName: 'Native Queued' },
    });
    await t.app.get(InvitationsService).send(null, queued.id, randomUUID(), 'Synthetic queued');
    const waiting = await t.prisma.nativeAuthToken.findFirstOrThrow({
      where: { userId: queued.id, purpose: 'ENROLL' },
    });
    expect(waiting.deliveryCiphertext).not.toBeNull();
    const tokens = t.app.get(NativeTokensService);
    await tokens.purgeExpired(new Date(Date.now() + 60_000));
    expect(
      (await t.prisma.nativeAuthChallenge.findUniqueOrThrow({ where: { id: stage.id } })).usedAt,
    ).toBeNull();
    await tokens.purgeExpired(new Date(waiting.expiresAt.getTime() + 1));
    expect(
      (await t.prisma.nativeAuthToken.findUniqueOrThrow({ where: { id: waiting.id } }))
        .deliveryCiphertext,
    ).toBeNull();
    const closed = await t.prisma.nativeAuthChallenge.findUniqueOrThrow({
      where: { id: stage.id },
    });
    expect(closed).toMatchObject({ passwordHash: null, totpCiphertext: null });
    expect(closed.usedAt).not.toBeNull();
    await post('mfa')
      .set('Cookie', item.pending)
      .send({ code: otp(item.secret) })
      .expect(401);
  });

  it('N9: queued mail of deactivated accounts never blocks an active recipient behind them', async () => {
    const send = (userId: string) =>
      t.app.get(InvitationsService).send(null, userId, randomUUID(), 'Synthetic queue order');
    const inactive: string[] = [];
    for (let i = 0; i < 10; i++) {
      const user = await t.prisma.user.create({
        data: { email: `native-off-${randomUUID()}@ayvo.test`, displayName: 'Native Off' },
      });
      await send(user.id);
      await t.prisma.user.update({
        where: { id: user.id },
        data: {
          status: 'DEACTIVATED',
          deactivatedAt: new Date(),
          deactivatedBy: user.id,
          deactivationReason: 'Synthetic deactivation',
        },
      });
      inactive.push(user.email);
    }
    const active = await t.prisma.user.create({
      data: { email: `native-on-${randomUUID()}@ayvo.test`, displayName: 'Native On' },
    });
    await send(active.id);
    const tokens = t.app.get(NativeTokensService);
    await tokens.deliverPending();
    const sent = tokens.deliveriesForTest().map((mail) => mail.to);
    expect(sent).toContain(active.email);
    expect(sent.filter((to) => inactive.includes(to))).toEqual([]);
    // The deactivated accounts' links stay queued untouched (a reactivation may still use them).
    expect(
      await t.prisma.nativeAuthToken.count({
        where: { user: { email: { in: inactive } }, sentAt: null, deliveryAttempts: 0 },
      }),
    ).toBe(10);
  });

  it('does not count an unknown or missing challenge against a shared account bucket', async () => {
    const hit = vi.spyOn(t.app.get(AuthRateLimitService), 'hit');
    await post('mfa').send({ code: '123456' }).expect(401);
    await post('mfa')
      .set('Cookie', `ayvo_auth=${'A'.repeat(43)}`)
      .send({ code: '123456' })
      .expect(401);
    expect(hit.mock.calls.map(([bucket]) => bucket)).toEqual(['login', 'login']);
  });

  it('atomically consumes a recovery code even across independent concurrent login challenges', async () => {
    const item = await activated();
    const a = await password(item.user.email);
    const b = await password(item.user.email);
    const results = await Promise.all(
      [a, b].map((pending) =>
        post('mfa').set('Cookie', pending).send({ code: item.recoveryCodes[0] }),
      ),
    );
    expect(results.map((value) => value.status).sort()).toEqual([200, 401]);
    expect(
      await t.prisma.nativeRecoveryCode.count({
        where: { userId: item.user.id, usedAt: { not: null } },
      }),
    ).toBe(1);
  });

  it('replaces MFA only after current credentials AND confirmation of the new authenticator', async () => {
    const item = await activated();
    await post('replace-mfa')
      .send({ password: PASSWORD, code: otp(item.secret) })
      .expect(401);
    const setup = await post('replace-mfa')
      .set('Cookie', item.session)
      .send({ password: PASSWORD, code: otp(item.secret) })
      .expect(200);
    const pending = cookies(setup, 'ayvo_auth');
    const newSecret = String(setup.body.setupKey);
    expect(newSecret).not.toBe(item.secret);
    expect(
      (await t.prisma.nativeCredential.findUniqueOrThrow({ where: { userId: item.user.id } }))
        .mfaRevision,
    ).toBe(1);
    const done = await post('mfa')
      .set('Cookie', pending)
      .send({ code: otp(newSecret) })
      .expect(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(
      (await t.prisma.nativeCredential.findUniqueOrThrow({ where: { userId: item.user.id } }))
        .mfaRevision,
    ).toBe(2);
    await http().get('/api/auth/me').set('Cookie', item.session).expect(401);
    await http().get('/api/auth/me').set('Cookie', cookies(done, 'ayvo_session')).expect(200);
    const next = await password(item.user.email);
    await post('mfa').set('Cookie', next).send({ code: item.recoveryCodes[0] }).expect(401);
  });

  it('retains same-origin CSRF checks and fails closed when Redis cannot decide', async () => {
    const item = await activated();
    await http()
      .post('/api/auth/native/password')
      .set('Origin', 'https://evil.example')
      .send({ email: item.user.email, password: PASSWORD })
      .expect(403);
    const count = await t.prisma.nativeAuthChallenge.count({ where: { userId: item.user.id } });
    vi.spyOn(t.redis, 'ready').mockRejectedValueOnce(new Error('synthetic Redis failure'));
    const denied = await post('password')
      .send({ email: item.user.email, password: PASSWORD })
      .expect(503);
    expect(denied.body.code).toBe('AUTH_UNAVAILABLE');
    expect(await t.prisma.nativeAuthChallenge.count({ where: { userId: item.user.id } })).toBe(
      count,
    );
  });

  it('enforces credential revisions and prevents replay-clock rewind at the database boundary', async () => {
    const item = await activated();
    await expect(
      t.prisma.nativeCredential.update({ where: { userId: item.user.id }, data: { revision: 2 } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.nativeCredential.update({
        where: { userId: item.user.id },
        data: { lastTotpStep: 0n },
      }),
    ).rejects.toThrow();
    const before = await t.prisma.nativeCredential.findUniqueOrThrow({
      where: { userId: item.user.id },
    });
    expect(before.revision).toBe(1);
  });
});
