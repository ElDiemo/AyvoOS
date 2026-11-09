import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const portalToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
/** A TOTP code; `offset` (ms) picks a neighbouring 30 s step (a used step is never accepted again). */
const otp = (secret: string, offset = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offset,
  });
/** A client IP no other test (or earlier run in the shared Redis) has used. */
const freshIp = () =>
  `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;

/**
 * "Zabezpečení účtu" of the hotel portal: the signed-in PORTAL account replaces its authenticator
 * app through `account/replace-mfa` (password + a current code or an unused recovery code), then
 * the ordinary `auth/mfa` with a code of the new app. Every earlier session ends, a new one and
 * new recovery codes are issued, the old app no longer signs in. Wrong input writes nothing; a
 * staff session, a foreign origin or another token is refused. Synthetic accounts only.
 */
describe.skipIf(!hasDatabase)('hotel portal: replacing the authenticator app', () => {
  let t: TestApp;
  const core = () => request(t.app.getHttpServer());
  const post = (path: string, session?: string, token = portalToken) => {
    const r = core()
      .post(`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const get = (path: string, session: string) =>
    core()
      .get(`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${portalToken}`)
      .set('x-ayvo-portal-session', session);
  let ip = freshIp();
  const client = (over: Partial<{ origin: string }> = {}) => ({
    ip,
    origin: PORTAL_ORIGIN,
    secFetchSite: 'same-origin',
    ...over,
  });
  const tokens = () => t.app.get(NativeTokensService);
  const lastMail = async (email: string) => {
    await tokens().deliverPending();
    return tokens()
      .deliveriesForTest()
      .findLast((m) => m.to === email);
  };
  const replacements = (userId: string) =>
    t.prisma.nativeAuthChallenge.count({ where: { userId, kind: 'REPLACE_MFA' } });

  /** An activated PORTAL account with its session (password + TOTP through the contract). */
  async function activated() {
    ip = freshIp();
    const user = await t.prisma.user.create({
      data: { email: unique('portal-acct'), displayName: 'Portal user', audience: 'PORTAL' },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'synthetic portal invitation', 'PORTAL');
    const link = tokenOf((await lastMail(user.email))!.url);
    const step = await post('auth/activate').send({
      token: link,
      password: PASSWORD,
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    const done = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: otp(step.body.setupKey),
      client: client(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return {
      user,
      secret: step.body.setupKey as string,
      session: done.body.session as string,
      recoveryCodes: done.body.recoveryCodes as string[],
    };
  }

  beforeAll(async () => {
    t = await createTestApp(
      {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
        PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
      },
      {},
      { auth: 'real', redis: 'real' },
    );
  });
  afterAll(() => t?.close());

  it('replaces the app: every old session ends, a new one with new recovery codes; only the new app signs in', async () => {
    const a = await activated();
    const other = await (async () => {
      const step = await post('auth/password').send({
        email: a.user.email,
        password: PASSWORD,
        client: client(),
      });
      const done = await post('auth/mfa').send({
        challenge: step.body.challenge,
        code: a.recoveryCodes.at(-1), // the TOTP window is kept for the replacement below
        client: client(),
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      return done.body.session as string;
    })();
    const step = await post('account/replace-mfa', a.session).send({
      password: PASSWORD,
      code: otp(a.secret, 30_000),
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    expect(step.body).toMatchObject({ step: 'ENROLL_MFA', maxAgeSeconds: 900 });
    expect(step.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const fresh = String(step.body.setupKey);
    expect(fresh).not.toBe(a.secret);
    // Until the new app is confirmed, nothing changed: the sessions still work.
    expect((await get('session', a.session)).status).toBe(200);
    // A code of the OLD app does not confirm the new one.
    expect(
      (
        await post('auth/mfa').send({
          challenge: step.body.challenge,
          code: otp(a.secret),
          client: client(),
        })
      ).status,
    ).toBe(401);
    const done = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: otp(fresh),
      client: client(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.step).toBe('DONE');
    expect(done.body.recoveryCodes).toHaveLength(a.recoveryCodes.length);
    expect(done.body.recoveryCodes).not.toEqual(a.recoveryCodes);
    // Both earlier sessions are over; the new one works.
    expect((await get('session', a.session)).status).toBe(401);
    expect((await get('session', other)).status).toBe(401);
    expect((await get('session', done.body.session)).status).toBe(200);
    // The old app and an old recovery code no longer sign in; the new app does.
    const old = await post('auth/password').send({
      email: a.user.email,
      password: PASSWORD,
      client: client(),
    });
    expect(
      (
        await post('auth/mfa').send({
          challenge: old.body.challenge,
          code: a.recoveryCodes[0],
          client: client(),
        })
      ).status,
    ).toBe(401);
    const again = await post('auth/password').send({
      email: a.user.email,
      password: PASSWORD,
      client: client(),
    });
    expect(
      (
        await post('auth/mfa').send({
          challenge: again.body.challenge,
          code: otp(fresh, 30_000),
          client: client(),
        })
      ).status,
    ).toBe(200);
    const audit = await t.prisma.auditEvent.findMany({
      where: { targetUserId: a.user.id, type: 'MFA_REPLACED' },
    });
    expect(audit).toHaveLength(1);
  });

  it('an unused recovery code starts it instead of the app; it is then used up', async () => {
    const a = await activated();
    const step = await post('account/replace-mfa', a.session).send({
      password: PASSWORD,
      code: a.recoveryCodes[0],
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    const twice = await post('account/replace-mfa', a.session).send({
      password: PASSWORD,
      code: a.recoveryCodes[0],
      client: client(),
    });
    expect(twice.status).toBe(401);
  });

  it('a wrong password or code writes nothing; without a portal session, from another origin or with another token: refused', async () => {
    const a = await activated();
    const before = await replacements(a.user.id);
    const wrongPassword = await post('account/replace-mfa', a.session).send({
      password: 'Uplne jine heslo AYVO 000',
      code: otp(a.secret, 30_000),
      client: client(),
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    const wrongCode = await post('account/replace-mfa', a.session).send({
      password: PASSWORD,
      code: '000000',
      client: client(),
    });
    expect(wrongCode.status).toBe(401);
    expect(await replacements(a.user.id)).toBe(before);
    // No session, an unknown one, another origin, Finance's or no token.
    const body = { password: PASSWORD, code: otp(a.secret, 30_000), client: client() };
    expect((await post('account/replace-mfa').send(body)).status).toBe(401);
    expect((await post('account/replace-mfa', 'x'.repeat(43)).send(body)).status).toBe(401);
    expect(
      (
        await post('account/replace-mfa', a.session).send({
          ...body,
          client: client({ origin: 'https://evil.example.test' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post('account/replace-mfa', a.session, randomBytes(32).toString('base64url')).send(
          body,
        )
      ).status,
    ).toBe(401);
    expect(await replacements(a.user.id)).toBe(before);
    // The portal session still works after the refusals.
    expect((await get('session', a.session)).status).toBe(200);
  });

  it('a staff session is unknown here', async () => {
    const user = await t.prisma.user.create({
      data: { email: unique('staff-acct'), displayName: 'Staff' },
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
    const staff = String(done.headers['set-cookie']).match(/ayvo_session=([^;]+)/)![1]!;
    const r = await post('account/replace-mfa', staff).send({
      password: PASSWORD,
      code: otp(String(step.body.setupKey), 30_000),
      client: client(),
    });
    expect(r.status).toBe(401);
    expect(await replacements(user.id)).toBe(0);
  });

  it('Odhlásit ze všech zařízení: every session of the account ends, this one too; audited; others untouched', async () => {
    const a = await activated();
    const b = await activated(); // another portal account
    const step = await post('auth/password').send({
      email: a.user.email,
      password: PASSWORD,
      client: client(),
    });
    const second = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: a.recoveryCodes[0],
      client: client(),
    });
    expect(second.status).toBe(200);
    // Another origin or no session: refused, nothing ended.
    expect(
      (
        await post('account/logout-all', a.session).send({
          client: client({ origin: 'https://evil.example.test' }),
        })
      ).status,
    ).toBe(403);
    expect((await post('account/logout-all').send({ client: client() })).status).toBe(401);
    expect((await get('session', a.session)).status).toBe(200);
    expect((await post('account/logout-all', a.session).send({ client: client() })).status).toBe(
      204,
    );
    expect((await get('session', a.session)).status).toBe(401);
    expect((await get('session', second.body.session)).status).toBe(401);
    expect((await get('session', b.session)).status).toBe(200);
    // Again with the ended session: 401, nothing more.
    expect((await post('account/logout-all', a.session).send({ client: client() })).status).toBe(
      401,
    );
    const audit = await t.prisma.auditEvent.findMany({
      where: { targetUserId: a.user.id, type: 'LOGOUT' },
    });
    expect(audit.map((x) => x.payload)).toEqual([{ allSessions: true, ended: 2 }]);
  });
});
