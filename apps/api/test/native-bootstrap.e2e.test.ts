import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Secret, TOTP } from 'otpauth';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapFirstAdmin } from '../src/identity/bootstrap.js';
import { InvitationsService } from '../src/identity/invitations.service.js';
import {
  activateBootstrap,
  BootstrapActivationRefused,
} from '../src/identity/native-bootstrap-activation.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { createTestApp, databaseUrl, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

/**
 * NATIVE59-R1: the first administrator's activation can be repeated by the operator (doc 038
 * §4) after an abandoned setup or exhausted delivery — with a NEW link by e-mail only, the old
 * link and setup invalidated, and a truthful report otherwise. The bootstrap is a singleton and
 * identity.e2e bootstraps the shared test database itself, so this file uses its own database.
 */
const EMAIL = 'native-bootstrap@ayvo.test';
const PASSWORD = 'Dlouhe heslo prvniho spravce 2026';
const cookie = (response: Response) =>
  (response.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('ayvo_auth='))!
    .split(';')[0]!;
const otp = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

describe.skipIf(!databaseUrl)('bootstrap administrator activation (operator command)', () => {
  const name = `ayvo_test_boot_${randomBytes(6).toString('hex')}`;
  let admin: PrismaClient;
  let t: TestApp;
  let userId: string;
  const apiRoot = resolve(import.meta.dirname, '..');
  const http = () => request(t.app.getHttpServer());
  const post = (path: string) =>
    http().post(`/api/auth/native/${path}`).set('Origin', TEST_APP_ORIGIN);
  const run = (resend = false) =>
    activateBootstrap(
      {
        prisma: t.prisma,
        invitations: t.app.get(InvitationsService),
        mail: t.app.get(NativeTokensService),
      },
      EMAIL,
      { resend, requestId: randomUUID() },
    );
  const mails = () =>
    t.app
      .get(NativeTokensService)
      .deliveriesForTest()
      .filter((m) => m.to === EMAIL);
  const lastLink = () =>
    new URLSearchParams(new URL(mails().at(-1)!.url).hash.slice(1)).get('token')!;

  beforeAll(async () => {
    const server = new URL(databaseUrl!);
    const own = new URL(databaseUrl!);
    own.pathname = `/${name}`;
    server.pathname = '/postgres';
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: server.toString() }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: own.toString() },
      stdio: 'pipe',
    });
    t = await createTestApp(
      { DATABASE_URL: own.toString(), AUTH_PROVIDER: 'local', AUTH_MAIL_DRIVER: 'memory' },
      {},
      { auth: 'real', redis: 'real' },
    );
    const boot = await bootstrapFirstAdmin(t.prisma, { email: EMAIL, displayName: 'Boot Admin' });
    if (!boot.ok) throw new Error('bootstrap failed');
    userId = boot.userId;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refuses anyone but the active bootstrap ADMIN and creates nothing for them', async () => {
    const other = await t.prisma.user.create({
      data: { email: `native-other-${randomUUID()}@ayvo.test`, displayName: 'Other' },
    });
    await expect(
      activateBootstrap(
        {
          prisma: t.prisma,
          invitations: t.app.get(InvitationsService),
          mail: t.app.get(NativeTokensService),
        },
        other.email,
        { resend: true, requestId: randomUUID() },
      ),
    ).rejects.toThrow(BootstrapActivationRefused);
    // A revoked ADMIN grant is refused even with --resend. (The database keeps one active
    // administrator: another synthetic ADMIN exists in this file's own database.)
    await t.prisma.userRole.create({
      data: { userId: other.id, roleCode: 'ADMIN', grantReason: 'synthetic second admin' },
    });
    const grant = await t.prisma.userRole.findFirstOrThrow({
      where: { userId, roleCode: 'ADMIN', revokedAt: null },
    });
    await t.prisma.userRole.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedBy: userId, revokeReason: 'synthetic' },
    });
    await expect(run(true)).rejects.toThrow(/no active ADMIN grant/);
    await t.prisma.userRole.create({
      data: { userId, roleCode: 'ADMIN', grantReason: 'synthetic restore' },
    });
    // An inactive bootstrap administrator is refused.
    await t.prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DEACTIVATED',
        deactivatedAt: new Date(),
        deactivatedBy: userId,
        deactivationReason: 'synthetic',
      },
    });
    await expect(run(true)).rejects.toThrow(/no active, unactivated/);
    await t.prisma.user.update({
      where: { id: userId },
      data: {
        status: 'ACTIVE',
        deactivatedAt: null,
        deactivatedBy: null,
        deactivationReason: null,
      },
    });
    expect(await t.prisma.nativeAuthToken.count()).toBe(0);
    expect(mails()).toEqual([]);
  });

  it('abandoned setup: a repeat reports it; --resend sends a new link and kills the old link and setup', async () => {
    expect(await run()).toMatchObject({ kind: 'accepted' });
    expect(mails()).toHaveLength(1);
    // A plain repeat while the link is unused: nothing new, truthfully "sent earlier".
    expect(await run()).toMatchObject({ kind: 'sent-earlier' });
    expect(mails()).toHaveLength(1);

    // The administrator opens the link, chooses a password, and abandons the MFA step.
    const first = lastLink();
    const abandoned = await post('activate').send({ token: first, password: PASSWORD }).expect(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await post('mfa')
      .set('Cookie', cookie(abandoned))
      .send({ code: otp(String(abandoned.body.setupKey)) })
      .expect(401);
    // Before NATIVE59-R1 this reported success from the old sent_at and sent nothing.
    expect(await run()).toEqual({ kind: 'needs-resend', why: 'setup-started' });
    expect(mails()).toHaveLength(1);

    // --resend: a new link; the first one is dead.
    expect(await run(true)).toMatchObject({ kind: 'accepted' });
    expect(mails()).toHaveLength(2);
    const second = lastLink();
    expect(second).not.toBe(first);
    await post('activate').send({ token: first, password: PASSWORD }).expect(400);

    // A setup still in progress with the second link is invalidated by another --resend.
    const inProgress = await post('activate')
      .send({ token: second, password: PASSWORD })
      .expect(200);
    expect(await run(true)).toMatchObject({ kind: 'accepted' });
    await post('mfa')
      .set('Cookie', cookie(inProgress))
      .send({ code: otp(String(inProgress.body.setupKey)) })
      .expect(401);
    await post('activate').send({ token: second, password: PASSWORD }).expect(400);
    expect(await t.prisma.nativeCredential.count({ where: { userId } })).toBe(0);
  });

  it('exhausted delivery: reported as such (never as queued for retry); --resend delivers again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let clock = Date.now() + 60 * 60_000;
    vi.setSystemTime(clock);
    const tokens = t.app.get(NativeTokensService);
    const outbox = tokens.deliveriesForTest() as { to: string; url: string }[];
    const push = vi.spyOn(outbox, 'push').mockImplementation(() => {
      throw new Error('synthetic mail failure');
    });
    expect(await run(true)).toEqual({ kind: 'queued', attempts: 1 });
    for (let i = 0; i < 6; i++) {
      clock += 6 * 60_000;
      vi.setSystemTime(clock);
      await tokens.deliverPending();
    }
    const token = await t.prisma.nativeAuthToken.findFirstOrThrow({
      where: { userId, usedAt: null, revokedAt: null, sentAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(token.deliveryAttempts).toBe(5);
    expect(await run()).toEqual({ kind: 'needs-resend', why: 'delivery-exhausted' });
    push.mockRestore();
    const before = mails().length;
    expect(await run(true)).toMatchObject({ kind: 'accepted' });
    expect(mails()).toHaveLength(before + 1);

    // The new link completes password + new MFA; afterwards the command refuses.
    const setup = await post('activate')
      .send({ token: lastLink(), password: PASSWORD })
      .expect(200);
    const done = await post('mfa')
      .set('Cookie', cookie(setup))
      .send({ code: otp(String(setup.body.setupKey)) })
      .expect(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    await expect(run(true)).rejects.toThrow(/no active, unactivated/);
    // Nothing but the activation itself changed the account's access.
    expect(await t.prisma.userRole.count({ where: { userId, revokedAt: null } })).toBe(1);
  });
});
