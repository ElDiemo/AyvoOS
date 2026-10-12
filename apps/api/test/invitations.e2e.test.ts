import { randomUUID } from 'node:crypto';
import type { AdminUserDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER } from '../src/identity/identity-provider.js';
import type { TestIdentityProvider } from '../src/identity/test.provider.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Invitations (doc 021 §7b): ADMIN prepares a user with roles and sites, AYVO invites through the
 * provider, the person registers through the invitation, the first sign-in links exactly that
 * identity. Real database, real guard and sessions, the fake provider (with failure markers in
 * the e-mail: +fail, +lost, +expired, +mismatch).
 */
describe.skipIf(!hasDatabase)('user invitations', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  const http = () => request(t.app.getHttpServer());
  const email = (tag = '') => `invitee-${randomUUID().slice(0, 8)}${tag}@ayvo.test`;
  const provider = () => t.app.get(IDENTITY_PROVIDER) as TestIdentityProvider;

  const create = async (address: string) => {
    const res = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({
        email: address,
        displayName: 'Invitee',
        roles: ['WAREHOUSE_OPERATOR'],
        siteIds: [INITIAL_SITE_ID],
        warehouseCodes: [],
        reason: 'new colleague',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as AdminUserDetail;
  };
  const action = (userId: string, path: '' | '/resend' | '/revoke', requestId = randomUUID()) =>
    http()
      .post(`/api/admin/identity/users/${userId}/invitations${path}`)
      .set('Cookie', admin)
      .send({ requestId, reason: 'invitation handling' });

  /** The whole browser flow; returns the final redirect of the callback. */
  async function signIn(address: string) {
    const start = await http().get('/api/auth/login').query({ next: '/', login_hint: address });
    const binding = /ayvo_login=([^;]+)/.exec(String(start.headers['set-cookie']))![1]!;
    const authorize = new URL(start.headers.location!);
    const providerRes = await http().get(authorize.pathname + authorize.search);
    const callback = new URL(providerRes.headers.location!);
    return { callback: callback.pathname + callback.search, binding };
  }
  const complete = (flow: { callback: string; binding: string }) =>
    http().get(flow.callback).set('Cookie', `ayvo_login=${flow.binding}`);

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: email('-admin'),
      displayName: 'Invitation Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('prepared user → invitation sent → registration → first sign-in links the identity', async () => {
    const address = email();
    const user = await create(address);
    expect(user.invitation).toMatchObject({ state: 'PENDING', acceptedAt: null });
    const days = (Date.parse(user.invitation!.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(user.linked).toBe(false);
    // Roles and sites are in place before the invitation is sent.
    expect(user.effectiveAccess.sites.map((s) => s.id)).toEqual([INITIAL_SITE_ID]);
    const sent = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'INVITATION_SENT', targetUserId: user.id },
    });
    expect(sent).toMatchObject({ actorUserId: adminId, reason: 'new colleague' });
    // Nothing secret is stored: the provider id only.
    const row = await t.prisma.userInvitation.findFirstOrThrow({ where: { userId: user.id } });
    expect(Object.keys(row)).not.toContain('token');

    const res = await complete(await signIn(address));
    expect(res.headers.location).toBe('/');
    const detail = (
      await http().get(`/api/admin/identity/users/${user.id}`).set('Cookie', admin).expect(200)
    ).body as AdminUserDetail;
    expect(detail).toMatchObject({ linked: true, invitation: { state: 'ACCEPTED' } });
    expect(detail.audit.map((a) => a.type)).toEqual(
      expect.arrayContaining(['INVITATION_ACCEPTED', 'IDENTITY_LINKED', 'LOGIN_SUCCEEDED']),
    );
    // A second invitation for a linked user is refused.
    expect((await action(user.id, '')).body.code).toBe('ALREADY_LINKED');
  });

  it('a lost provider response is reconciled on retry — never a second invitation', async () => {
    const address = email('+lost');
    const user = await create(address);
    // The provider created it but the answer never arrived: still SENDING, not FAILED — and the
    // audit says exactly that.
    expect(user.invitation?.state).toBe('SENDING');
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_INTERRUPTED', targetUserId: user.id },
      }),
    ).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_FAILED', targetUserId: user.id },
      }),
    ).toBe(0);
    expect((await action(user.id, '')).body.code).toBe('INVITATION_OPEN');
    const requestId = randomUUID();
    const first = await action(user.id, '/resend', requestId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.invitation.state).toBe('PENDING');
    // Repeating the same request is a no-op.
    const again = await action(user.id, '/resend', requestId);
    expect(again.status).toBe(200);
    expect(await provider().findPendingInvitations(address)).toHaveLength(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_SENT', targetUserId: user.id },
      }),
    ).toBe(1);
    // The same request id for another action is a conflict.
    expect((await action(user.id, '/revoke', requestId)).body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a provider failure leaves a prepared user who cannot sign in', async () => {
    const address = email('+fail');
    const user = await create(address);
    expect(user.invitation).toMatchObject({ state: 'FAILED', failureCode: 'PROVIDER_REFUSED' });
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_FAILED', targetUserId: user.id },
      }),
    ).toBe(1);
    const retryId = randomUUID();
    const retry = await action(user.id, '/resend', retryId);
    expect(retry.status).toBe(502);
    expect(retry.body.code).toBe('INVITATION_PROVIDER_FAILED');
    // The same attempt repeated answers the same — deterministically, without a new provider call.
    const repeated = await action(user.id, '/resend', retryId);
    expect(repeated.status).toBe(502);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_FAILED', targetUserId: user.id },
      }),
    ).toBe(2);
    // The administrator sees the failed state and can safely try again.
    const shown = (
      await http().get(`/api/admin/identity/users/${user.id}`).set('Cookie', admin).expect(200)
    ).body as AdminUserDetail;
    expect(shown.invitation).toMatchObject({ state: 'FAILED', failureCode: 'PROVIDER_REFUSED' });
    expect((await complete(await signIn(address))).headers.location).toBe(
      '/account-inactive?reason=no-access',
    );
    expect(await t.prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a revoked invitation cannot be used; revoking is idempotent; resending invites anew', async () => {
    const address = email();
    const user = await create(address);
    const requestId = randomUUID();
    const revoked = await action(user.id, '/revoke', requestId);
    expect(revoked.status).toBe(200);
    expect(revoked.body.invitation.state).toBe('REVOKED');
    expect((await action(user.id, '/revoke', requestId)).status).toBe(200);
    expect((await action(user.id, '/revoke')).status).toBe(200);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_REVOKED', targetUserId: user.id },
      }),
    ).toBe(1);
    expect(await provider().findPendingInvitations(address)).toHaveLength(0);
    expect((await complete(await signIn(address))).headers.location).toBe(
      '/account-inactive?reason=no-access',
    );
    const renewed = await action(user.id, '/resend');
    expect(renewed.body.invitation.state).toBe('PENDING');
    expect((await complete(await signIn(address))).headers.location).toBe('/');
  });

  it('an expired invitation is shown as expired and refused at sign-in', async () => {
    const address = email('+expired');
    const user = await create(address);
    expect(user.invitation?.state).toBe('EXPIRED');
    expect((await complete(await signIn(address))).headers.location).toBe(
      '/account-inactive?reason=no-access',
    );
    expect(
      (await t.prisma.userInvitation.findFirstOrThrow({ where: { userId: user.id } })).state,
    ).toBe('EXPIRED');
  });

  it('e-mails are normalized; duplicates and concurrent invitations are prevented', async () => {
    const local = `Mixed-${randomUUID().slice(0, 6)}`;
    const user = await create(`  ${local}@AYVO.test `);
    expect(user.email).toBe(`${local.toLowerCase()}@ayvo.test`);
    const dup = await http()
      .post('/api/admin/identity/users')
      .set('Cookie', admin)
      .send({
        email: `${local.toUpperCase()}@ayvo.TEST`,
        displayName: 'Duplicate',
        roles: [],
        siteIds: [],
        warehouseCodes: [],
        reason: 'duplicate attempt',
      });
    expect(dup.body.code).toBe('USER_EXISTS');
    // Two concurrent new invitations after a revocation: exactly one wins.
    await action(user.id, '/revoke');
    const results = await Promise.all([action(user.id, ''), action(user.id, '')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await provider().findPendingInvitations(user.email)).toHaveLength(1);
    // The database refuses a second open invitation whatever the application does.
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "user_invitations" ("user_id", "email", "provider", "request_id")
        VALUES (${user.id}::uuid, ${user.email}, 'TEST', ${randomUUID()}::uuid)`,
    ).rejects.toThrow();
  });

  it('an invitation accepted by another provider identity links nothing', async () => {
    const address = email('+mismatch');
    const user = await create(address);
    expect((await complete(await signIn(address))).headers.location).toBe(
      '/account-inactive?reason=no-access',
    );
    expect(await t.prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);
    const denied = await t.prisma.auditEvent.findMany({ where: { type: 'LOGIN_DENIED' } });
    expect(
      denied.some(
        (a) =>
          (a.payload as { email?: string; detail?: string }).email === address &&
          (a.payload as { detail?: string }).detail === 'INVITATION_MISMATCH',
      ),
    ).toBe(true);
  });

  it('simultaneous first sign-ins link the identity exactly once', async () => {
    const address = email();
    const user = await create(address);
    const flows = await Promise.all([signIn(address), signIn(address), signIn(address)]);
    const results = await Promise.all(flows.map(complete));
    expect(results.map((r) => r.headers.location)).toEqual(['/', '/', '/']);
    expect(await t.prisma.userIdentity.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'INVITATION_ACCEPTED', targetUserId: user.id },
      }),
    ).toBe(1);
  });

  it('a deactivated invited user stays refused although the provider signs them in', async () => {
    const address = email();
    const user = await create(address);
    await http()
      .post(`/api/admin/identity/users/${user.id}/deactivate`)
      .set('Cookie', admin)
      .send({ reason: 'did not start' })
      .expect(200);
    expect((await complete(await signIn(address))).headers.location).toBe('/account-inactive');
    expect(await t.prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);
    expect((await action(user.id, '/resend')).body.code).toBe('USER_INACTIVE');
    // Audit history stays.
    expect(
      await t.prisma.auditEvent.count({
        where: { targetUserId: user.id, type: 'INVITATION_SENT' },
      }),
    ).toBe(1);
  });

  it('only ADMIN manages invitations; outsiders learn nothing about who exists', async () => {
    const address = email();
    const user = await create(address);
    await complete(await signIn(address));
    const operator = await sessionCookie(t, address);
    for (const path of ['', '/resend', '/revoke']) {
      const res = await http()
        .post(`/api/admin/identity/users/${user.id}/invitations${path}`)
        .set('Cookie', operator)
        .send({ requestId: randomUUID(), reason: 'self service' });
      expect(res.status).toBe(403);
    }
    // An unknown and an uninvited known e-mail get the same answer.
    const known = await prepareInvitedUser(t, { email: email(), displayName: 'Known' });
    await action(known.id, '/revoke');
    const a = await complete(await signIn(email('-unknown')));
    const b = await complete(await signIn(known.email));
    expect(a.headers.location).toBe(b.headers.location);
  });

  describe('acceptance racing an administrative action', () => {
    /** Runs the person's registration + first sign-in while the provider call is in flight. */
    function acceptDuring(
      method: 'revokeInvitation' | 'resendInvitation',
      address: string,
    ): () => void {
      const p = provider();
      const original = p[method].bind(p);
      p[method] = async (id: string) => {
        const res = await complete(await signIn(address));
        expect(res.headers.location).toBe('/');
        return original(id);
      };
      return () => {
        p[method] = original;
      };
    }

    it('a revocation that loses against the acceptance says so and audits the truth', async () => {
      const address = email();
      const user = await create(address);
      const restore = acceptDuring('revokeInvitation', address);
      const requestId = randomUUID();
      let res;
      try {
        res = await action(user.id, '/revoke', requestId);
      } finally {
        restore();
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVITATION_ACCEPTED');
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'INVITATION_REVOKED', targetUserId: user.id },
        }),
      ).toBe(0);
      const skipped = await t.prisma.auditEvent.findFirstOrThrow({
        where: { type: 'INVITATION_ACTION_SKIPPED', targetUserId: user.id },
      });
      expect(skipped.payload).toMatchObject({ kind: 'REVOKE', outcome: 'SKIPPED_ACCEPTED' });
      const detail = (
        await http().get(`/api/admin/identity/users/${user.id}`).set('Cookie', admin).expect(200)
      ).body as AdminUserDetail;
      expect(detail).toMatchObject({ linked: true, invitation: { state: 'ACCEPTED' } });
      // The same request repeated gets the same answer.
      expect((await action(user.id, '/revoke', requestId)).body.code).toBe('INVITATION_ACCEPTED');
    });

    it('a resend that loses against the acceptance says so and audits the truth', async () => {
      const address = email();
      const user = await create(address);
      const restore = acceptDuring('resendInvitation', address);
      let res;
      try {
        res = await action(user.id, '/resend');
      } finally {
        restore();
      }
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVITATION_ACCEPTED');
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'INVITATION_RESENT', targetUserId: user.id },
        }),
      ).toBe(0);
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'INVITATION_FAILED', targetUserId: user.id },
        }),
      ).toBe(0);
      const skipped = await t.prisma.auditEvent.findFirstOrThrow({
        where: { type: 'INVITATION_ACTION_SKIPPED', targetUserId: user.id },
      });
      expect(skipped.payload).toMatchObject({ kind: 'RESEND', outcome: 'SKIPPED_ACCEPTED' });
    });
  });
});
