import { randomUUID } from 'node:crypto';
import type { PortalAccountListItem } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { createHotel } from './support/order-fixtures.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const ADMIN_REASON = 'portal accounts test';
const reason = { reason: 'Synthetický test účtů portálu' };

/**
 * Hotely → Uživatelé: hotel portal (PORTAL) accounts are not internal users. Every internal user
 * route (list, detail, access, roles, scopes, invitations, status, business card) answers as if a
 * PORTAL id did not exist; the separate portal accounts routes list them with their grants and
 * deactivate/reactivate them with the same rules, session revocation and audit types. Synthetic
 * accounts and hotels only.
 */
describe.skipIf(!hasDatabase)(
  'Hotely → Uživatelé: portal accounts apart from internal users',
  () => {
    let t: TestApp;
    let su: TestApp;
    let admin: string;
    let operator: string;
    let adminId: string;
    let hotelA: { id: string; code: string; name: string };
    let hotelB: { id: string; code: string; name: string };

    const asSu = () => request(su.app.getHttpServer());
    const portalAccount = async (displayName = 'Recepce') => {
      const user = await t.prisma.user.create({
        data: { email: unique('portal'), displayName, audience: 'PORTAL' },
      });
      return user;
    };
    const grant = (userId: string, hotelIds: string[]) =>
      t.app.get(PortalGrantsService).issue(adminId, {
        requestId: randomUUID(),
        userId,
        payerCustomerId: randomUUID(),
        hotelIds,
        reason: 'synthetic portal grant',
        financeCheck: { payerVersion: 1, hotelIds, checkedAt: new Date().toISOString() },
      });
    /** An open PORTAL session of the account (as the portal sign-in creates one). */
    const openSession = (userId: string) =>
      t.prisma.$transaction(async (tx) => {
        const identity = await tx.userIdentity.create({
          data: { userId, provider: 'LOCAL', subject: randomUUID(), emailAtLink: 'x@ayvo.test' },
        });
        return t.app.get(SessionsService).create(tx, {
          userId,
          identityId: identity.id,
          providerSessionId: null,
          audience: 'PORTAL',
        });
      });

    beforeAll(async () => {
      t = await createTestApp({}, {}, { auth: 'real' });
      su = await createTestApp();
      const a = await prepareInvitedUser(t, { email: unique('acc-admin'), displayName: 'Admin' });
      adminId = a.id;
      await t.prisma.userRole.create({
        data: { userId: a.id, roleCode: 'ADMIN', grantReason: ADMIN_REASON },
      });
      admin = await sessionCookie(t, a.email);
      const o = await prepareInvitedUser(t, { email: unique('acc-op'), displayName: 'Operator' });
      await t.prisma.userRole.create({
        data: { userId: o.id, roleCode: 'WAREHOUSE_OPERATOR', grantReason: ADMIN_REASON },
      });
      operator = await sessionCookie(t, o.email);
      const ha = await createHotel(su, { name: 'Hotel Účty A' });
      const hb = await createHotel(su, { name: 'Hotel Účty B' });
      hotelA = { id: ha.id, code: ha.code, name: ha.name };
      hotelB = { id: hb.id, code: hb.code, name: hb.name };
    });
    afterAll(async () => {
      // Other test files bootstrap the first ADMIN: leave no open ADMIN grant behind.
      await t?.prisma.userRole.updateMany({
        where: { roleCode: 'ADMIN', revokedAt: null, grantReason: ADMIN_REASON },
        data: { revokedAt: new Date(), revokeReason: 'end of test' },
      });
      await t?.close();
      await su?.close();
    });

    it('internal users: a portal account is never listed, shown or changed (404), staff still is', async () => {
      const portal = await portalAccount();
      await grant(portal.id, [hotelA.id]);
      const staff = await t.prisma.user.create({
        data: { email: unique('staff'), displayName: 'Staff' },
      });
      const list = (await asSu().get('/api/admin/identity/users').expect(200)).body as {
        id: string;
      }[];
      expect(list.some((u) => u.id === portal.id)).toBe(false);
      expect(list.some((u) => u.id === staff.id)).toBe(true);
      expect((await asSu().get(`/api/admin/identity/users/${portal.id}`)).status).toBe(404);
      await asSu().get(`/api/admin/identity/users/${staff.id}`).expect(200);

      const before = await t.prisma.user.findUniqueOrThrow({ where: { id: portal.id } });
      const audits = () => t.prisma.auditEvent.count({ where: { targetUserId: portal.id } });
      const auditsBefore = await audits();
      const site = await t.prisma.site.findFirstOrThrow({ where: { active: true } });
      const calls: [string, Record<string, unknown>][] = [
        [
          'access',
          { roles: [], siteIds: [], warehouseCodes: [], ...reason, requestId: randomUUID() },
        ],
        ['roles/grant', { role: 'WAREHOUSE_OPERATOR', ...reason }],
        ['roles/revoke', { role: 'WAREHOUSE_OPERATOR', ...reason }],
        ['sites/grant', { siteId: site.id, ...reason }],
        ['sites/revoke', { siteId: site.id, ...reason }],
        ['warehouses/grant', { warehouseCode: 'NO-SUCH', ...reason }],
        ['warehouses/revoke', { warehouseCode: 'NO-SUCH', ...reason }],
        ['deactivate', reason],
        ['reactivate', reason],
        ['invitations', { requestId: randomUUID(), ...reason }],
        ['invitations/resend', { requestId: randomUUID(), ...reason }],
        ['invitations/revoke', { requestId: randomUUID(), ...reason }],
      ];
      for (const [path, body] of calls) {
        const res = await asSu().post(`/api/admin/identity/users/${portal.id}/${path}`).send(body);
        expect([res.status, res.body.code], path).toEqual([404, 'USER_NOT_FOUND']);
      }
      const card = await asSu().get(`/api/admin/identity/users/${portal.id}/business-card`);
      expect(card.status).toBe(404);
      const save = await asSu()
        .post(`/api/admin/identity/users/${portal.id}/business-card`)
        .send({
          requestId: randomUUID(),
          slug: `p-${randomUUID().slice(0, 8)}`,
          fields: { displayName: 'X' },
          reason: 'synthetic',
        });
      expect([400, 404]).toContain(save.status);
      expect(await t.prisma.employeeCard.count({ where: { userId: portal.id } })).toBe(0);
      expect(await t.prisma.user.findUniqueOrThrow({ where: { id: portal.id } })).toEqual(before);
      expect(await t.prisma.userRole.count({ where: { userId: portal.id } })).toBe(0);
      expect(await t.prisma.userScope.count({ where: { userId: portal.id } })).toBe(0);
      expect(await audits()).toBe(auditsBefore);
    });

    it('Hotely → Uživatelé lists portal accounts only, with grants, hotels, invitation and sessions', async () => {
      const portal = await portalAccount('Recepce Účty');
      const g1 = await grant(portal.id, [hotelB.id, hotelA.id]);
      const g2 = await grant(portal.id, [hotelB.id]);
      await t.app.get(PortalGrantsService).revoke(adminId, g2.id, 'synthetic revocation');
      await openSession(portal.id);
      const staff = await t.prisma.user.create({
        data: { email: unique('staff-2'), displayName: 'Staff 2' },
      });
      const res = await request(t.app.getHttpServer())
        .get('/api/admin/identity/portal-accounts')
        .set('Cookie', admin)
        .expect(200);
      const accounts = res.body as PortalAccountListItem[];
      expect(accounts.some((a) => a.id === staff.id)).toBe(false);
      expect(accounts.some((a) => a.id === adminId)).toBe(false);
      const mine = accounts.find((a) => a.id === portal.id)!;
      expect(mine).toMatchObject({
        email: portal.email,
        displayName: 'Recepce Účty',
        status: 'ACTIVE',
        signsIn: false,
        invitation: 'NONE',
        activeSessions: 1,
      });
      // Active grant first, then the revoked one; hotels by code with their names.
      expect(mine.grants.map((g) => [g.id, g.revokedAt === null])).toEqual([
        [g1.id, true],
        [g2.id, false],
      ]);
      expect(mine.grants[0]!.hotels).toEqual(
        [hotelA, hotelB].sort((a, b) => a.code.localeCompare(b.code)),
      );
      expect(mine.grants[1]!.revokeReason).toBe('synthetic revocation');
      const one = await request(t.app.getHttpServer())
        .get(`/api/admin/identity/portal-accounts/${portal.id}`)
        .set('Cookie', admin)
        .expect(200);
      expect(one.body).toEqual(mine);
      for (const id of [staff.id, randomUUID()]) {
        const r = await request(t.app.getHttpServer())
          .get(`/api/admin/identity/portal-accounts/${id}`)
          .set('Cookie', admin);
        expect([r.status, r.body.code]).toEqual([404, 'USER_NOT_FOUND']);
      }
    });

    it('deactivation ends its sessions now and is audited; reactivation too; a staff id is unknown', async () => {
      const portal = await portalAccount();
      await grant(portal.id, [hotelA.id]);
      await openSession(portal.id);
      const http = () => request(t.app.getHttpServer());
      const off = await http()
        .post(`/api/admin/identity/portal-accounts/${portal.id}/deactivate`)
        .set('Cookie', admin)
        .send(reason);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body).toMatchObject({
        status: 'DEACTIVATED',
        deactivationReason: reason.reason,
        activeSessions: 0,
      });
      expect(
        await t.prisma.userSession.count({
          where: { userId: portal.id, revokedAt: null },
        }),
      ).toBe(0);
      const again = await http()
        .post(`/api/admin/identity/portal-accounts/${portal.id}/deactivate`)
        .set('Cookie', admin)
        .send(reason);
      expect([again.status, again.body.code]).toEqual([409, 'ALREADY_DEACTIVATED']);
      const on = await http()
        .post(`/api/admin/identity/portal-accounts/${portal.id}/reactivate`)
        .set('Cookie', admin)
        .send(reason);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ status: 'ACTIVE', deactivatedAt: null });
      const events = await t.prisma.auditEvent.findMany({
        where: { targetUserId: portal.id, type: { in: ['USER_DEACTIVATED', 'USER_REACTIVATED'] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => [e.type, e.actorUserId, e.reason])).toEqual([
        ['USER_DEACTIVATED', adminId, reason.reason],
        ['USER_REACTIVATED', adminId, reason.reason],
      ]);
      // An internal account is unknown on these routes.
      const staff = await t.prisma.user.create({
        data: { email: unique('staff-3'), displayName: 'Staff 3' },
      });
      const wrong = await http()
        .post(`/api/admin/identity/portal-accounts/${staff.id}/deactivate`)
        .set('Cookie', admin)
        .send(reason);
      expect([wrong.status, wrong.body.code]).toEqual([404, 'USER_NOT_FOUND']);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('needs the grant administrators’ permission (and users_manage to change status)', async () => {
      const portal = await portalAccount();
      const http = () => request(t.app.getHttpServer());
      expect((await http().get('/api/admin/identity/portal-accounts')).status).toBe(401);
      expect(
        (await http().get('/api/admin/identity/portal-accounts').set('Cookie', operator)).status,
      ).toBe(403);
      expect(
        (
          await http()
            .post(`/api/admin/identity/portal-accounts/${portal.id}/deactivate`)
            .set('Cookie', operator)
            .send(reason)
        ).status,
      ).toBe(403);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: portal.id } })).status).toBe(
        'ACTIVE',
      );
    });

    it('one hotel’s card: only the accounts with an active grant naming it, only those grants — filtered on the server', async () => {
      const hc = await createHotel(su, { name: 'Hotel Karta' });
      const onCard = await portalAccount('Recepce Karta');
      const other = await portalAccount('Recepce Jinde');
      const revoked = await portalAccount('Recepce Odvolaná');
      await grant(onCard.id, [hotelB.id]); // its other grant is not on the card
      await grant(onCard.id, [hc.id, hotelA.id]);
      await grant(other.id, [hotelA.id]);
      const gone = await grant(revoked.id, [hc.id]);
      await t.app.get(PortalGrantsService).revoke(adminId, gone.id, 'synthetic revocation');
      const card = (
        await asSu()
          .get('/api/admin/identity/portal-accounts')
          .query({ hotelId: hc.id })
          .expect(200)
      ).body as PortalAccountListItem[];
      expect(card.map((a) => a.email)).toEqual([onCard.email]);
      expect(card[0]!.grants).toHaveLength(1);
      expect(card[0]!.grants[0]!.hotels.map((h) => h.id).sort()).toEqual([hc.id, hotelA.id].sort());
      expect(card[0]!.grants[0]!.revokedAt).toBeNull();
      // An unknown hotel has no accounts; a malformed filter or an unknown parameter is refused.
      expect(
        (await asSu().get('/api/admin/identity/portal-accounts').query({ hotelId: randomUUID() }))
          .body,
      ).toEqual([]);
      for (const q of [{ hotelId: 'nope' }, { hotel: hc.id }])
        expect((await asSu().get('/api/admin/identity/portal-accounts').query(q)).status).toBe(400);
    });

    it('the hotel filter needs the same permission: no list and no e-mail without it', async () => {
      const portal = await portalAccount('Recepce Bez Práva');
      await grant(portal.id, [hotelA.id]);
      const res = await request(t.app.getHttpServer())
        .get('/api/admin/identity/portal-accounts')
        .query({ hotelId: hotelA.id })
        .set('Cookie', operator);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(portal.email);
      expect(
        (
          await request(t.app.getHttpServer())
            .get('/api/admin/identity/portal-accounts')
            .query({ hotelId: hotelA.id })
        ).status,
      ).toBe(401);
    });
  },
);
