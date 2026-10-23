import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, ProspectDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalesViews } from '../src/sales/sales-views.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Obchod (doc 034 §7), Codex SALES44-R2: a prospect's detail is checked and read from ONE
 * snapshot. A read by salesperson A that is paused after its permission check must never return
 * what the prospect became after ADMIN handed it to B (B's owner, B's new private note). The
 * interleaving is forced: the read is held between its check and the loading of the detail.
 */
describe.skipIf(!hasDatabase)('Obchod — the detail never outlives its permission check', () => {
  let t: TestApp;
  let admin: string;
  let adminId: string;
  const people: Record<'a' | 'b', { id: string; cookie: string }> = {} as never;
  const http = () => request(t.app.getHttpServer());
  const unique = (n: string) => `${n}-${randomUUID().slice(0, 8)}@ayvo.test`;
  const tag = randomUUID().slice(0, 6);
  const base = '/api/admin/sales';

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, { email: unique('race-admin'), displayName: 'Admin' });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    for (const key of ['a', 'b'] as const) {
      const email = unique(`race-${key}`);
      const created = await http()
        .post('/api/admin/identity/users')
        .set('Cookie', admin)
        .send({
          email,
          displayName: `Obchodník ${key.toUpperCase()} ${tag}`,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'salesperson',
        })
        .expect(201);
      people[key] = {
        id: (created.body as AdminUserDetail).id,
        cookie: await sessionCookie(t, email),
      };
    }
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('a read paused after the check, then a handover and B’s note: nothing of B leaks', async () => {
    const created = (
      await http()
        .post(`${base}/prospects`)
        .set('Cookie', people.a.cookie)
        .send({
          requestId: randomUUID(),
          name: `Hotel Předávaný ${tag}`,
          countryCode: 'CZ',
          city: null,
          addressLine1: null,
          addressLine2: null,
          postalCode: null,
          roomsEstimate: null,
          accommodationType: null,
          website: null,
          source: null,
          priority: null,
          note: 'Poznámka obchodníka A',
          ownerId: null,
          contact: null,
          acknowledgeDuplicates: false,
        })
        .expect(201)
    ).body as ProspectDetail;
    const secret = `Soukromá poznámka B ${tag}`;

    // A controlled pause exactly between A's permission check and the loading of the detail:
    // the running application's SalesViews.detail waits at a gate the test opens.
    const views = t.app.get(SalesViews);
    const original = views.detail.bind(views);
    let open!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const atGate = new Promise<void>((r) => (paused = r));
    let first = true;
    views.detail = async (...args: Parameters<typeof original>) => {
      // Only A's read is held; the handover's own answer passes.
      if (first) {
        first = false;
        paused();
        await gate;
      }
      return original(...args);
    };
    let read!: Promise<request.Response>;
    try {
      read = http()
        .get(`${base}/prospects/${created.code}`)
        .set('Cookie', people.a.cookie)
        .then((r) => r);
      await atGate;
      // Meanwhile the prospect is handed to B and B writes a private note (both committed).
      await http()
        .post(`${base}/prospects/${created.code}/owner`)
        .set('Cookie', admin)
        .send({
          requestId: randomUUID(),
          revision: created.revision,
          ownerId: people.b.id,
          reason: 'předání kolegyni',
        })
        .expect(200);
      const now = await t.prisma.salesProspect.findUniqueOrThrow({ where: { code: created.code } });
      await t.prisma.salesProspect.update({
        where: { code: created.code },
        data: { note: secret, revision: now.revision + 1, updatedBy: people.b.id },
      });
    } finally {
      views.detail = original;
      open();
    }

    const res = await read;
    // Either A's read is answered from the moment it was allowed (A still the owner), or it is
    // refused — but it never carries what the prospect became for B.
    expect([200, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    if (res.status === 200) {
      const d = res.body as ProspectDetail;
      expect(d.owner.id).toBe(people.a.id);
      expect(d.note).toBe('Poznámka obchodníka A');
    }
    // A fresh read by A is refused now; B sees the note.
    expect(
      (await http().get(`${base}/prospects/${created.code}`).set('Cookie', people.a.cookie)).status,
    ).toBe(404);
    const b = (
      await http()
        .get(`${base}/prospects/${created.code}`)
        .set('Cookie', people.b.cookie)
        .expect(200)
    ).body as ProspectDetail;
    expect(b.note).toBe(secret);
  });
});
