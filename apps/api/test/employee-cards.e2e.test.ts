import { randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';

describe.skipIf(!hasDatabase)(
  'employee cards — real authentication and migrated PostgreSQL',
  () => {
    let t: TestApp, admin: string, sales: string, employeeId: string, adminId: string;
    const http = () => request(t.app.getHttpServer());
    const path = () => `/api/admin/identity/users/${employeeId}/business-card`;
    const slug = `card-${randomUUID()}`;
    const fields = {
      name: 'Jana Testová',
      role: 'Obchod',
      company: 'AYVO',
      tagline: 'Syntetická vizitka',
      phone: '+420 111 222 333',
      email: 'public@example.com',
      website: 'https://example.com',
      linkedin: '',
      photoId: null as string | null,
    };
    let version = 0;
    let firstPublication: ReturnType<typeof action>;
    const post = (suffix = '') =>
      http()
        .post(path() + suffix)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN);
    const action = () => ({
      requestId: randomUUID(),
      expectedVersion: version,
      reason: 'Test business card action',
    });

    beforeAll(async () => {
      t = await createTestApp({}, {}, { auth: 'real' });
      const a = await prepareInvitedUser(t, {
        email: `card-admin-${randomUUID()}@ayvo.test`,
        displayName: 'Card Test Admin',
      });
      adminId = a.id;
      await t.prisma.userRole.create({
        data: { userId: a.id, roleCode: 'ADMIN', grantReason: 'isolated test' },
      });
      admin = await sessionCookie(t, a.email);
      const e = await prepareInvitedUser(t, {
        email: `card-login-${randomUUID()}@ayvo.test`,
        displayName: 'Internal Employee Name',
      });
      employeeId = e.id;
      await t.prisma.userRole.create({
        data: { userId: e.id, roleCode: 'SALES', grantReason: 'isolated test' },
      });
      sales = await sessionCookie(t, e.email);
    });
    afterAll(async () => {
      if (t) await t.close();
    });

    it('refuses anonymous and SALES administration, including photo access', async () => {
      await http().get(path()).expect(401);
      await http().get(path()).set('Cookie', sales).expect(403);
      await http()
        .post(path())
        .set('Cookie', sales)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ ...action(), slug, fields })
        .expect(403);
      await http().get(`${path()}/photos/${randomUUID()}`).set('Cookie', sales).expect(403);
    });

    it('creates an unpublished draft; upload is private until explicitly published', async () => {
      const png = createCanvas(32, 32).toBuffer('image/png');
      const uploaded = await post('/photos')
        .field('requestId', randomUUID())
        .attach('file', png, 'photo.png')
        .expect(201);
      fields.photoId = uploaded.body.id as string;
      await http().get(`${path()}/photos/${fields.photoId}`).set('Cookie', admin).expect(200);
      const input = { ...action(), slug, fields };
      const created = await post().send(input).expect(200);
      version = created.body.card.version as number;
      expect(created.body.card.published).toBeNull();
      await http().get(`/api/public/employee-cards/${slug}`).expect(404);
      const replay = await post().send(input).expect(200);
      expect(replay.body).toEqual(created.body);
      await post()
        .send({ ...input, fields: { ...fields, role: 'Changed with reused ID' } })
        .expect(409);
    });

    it('publishes only public fields and keeps later draft changes private', async () => {
      firstPublication = action();
      const published = await post('/publish').send(firstPublication).expect(200);
      version = published.body.card.version as number;
      const res = await http().get(`/api/public/employee-cards/${slug}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'slug',
          'version',
          'hasPhoto',
          'name',
          'role',
          'company',
          'tagline',
          'phone',
          'email',
          'website',
          'linkedin',
        ].sort(),
      );
      expect(JSON.stringify(res.body)).not.toContain('card-login-');
      const photoVersion = version;
      await http()
        .get(`/api/public/employee-cards/${slug}/photo?version=${photoVersion}`)
        .expect(200)
        .expect('Content-Type', /image\/png/);
      const saved = await post()
        .send({ ...action(), slug, fields: { ...fields, name: 'Private unpublished change' } })
        .expect(200);
      version = saved.body.card.version as number;
      expect((await http().get(`/api/public/employee-cards/${slug}`).expect(200)).body.name).toBe(
        fields.name,
      );
      await http()
        .get(`/api/public/employee-cards/${slug}/photo?version=${photoVersion}`)
        .expect(200);
      const contact = await http()
        .get(`/api/public/employee-cards/${slug}/contact.vcf`)
        .expect(200);
      expect(contact.headers['content-disposition']).toBe(`attachment; filename="${slug}.vcf"`);
      expect(contact.text).toContain('FN:Jana Testová');
      expect(contact.text).not.toContain('Private unpublished');
    });

    it('does not overwrite concurrent edits and never changes a printed slug', async () => {
      await post()
        .send({ ...action(), expectedVersion: version - 1, slug, fields })
        .expect(409);
      await post()
        .send({ ...action(), slug: `${slug}-changed`, fields })
        .expect(409);
      const responses = await Promise.all([
        post().send({ ...action(), slug, fields: { ...fields, role: 'Concurrent A' } }),
        post().send({ ...action(), slug, fields: { ...fields, role: 'Concurrent B' } }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      version = responses.find((r) => r.status === 200)!.body.card.version as number;
    });

    it('hide revokes the publication, vCard and old photograph URLs', async () => {
      const publishedVersion = (
        await t.prisma.employeeCard.findUniqueOrThrow({ where: { userId: employeeId } })
      ).publishedVersion;
      const hidden = await post('/hide').send(action()).expect(200);
      version = hidden.body.card.version as number;
      const replay = await post('/publish').send(firstPublication).expect(200);
      expect(replay.body.card.published).toBeNull();
      expect(replay.body.card.version).toBe(version);
      for (const suffix of ['', '/contact.vcf', `/photo?version=${publishedVersion}`]) {
        await http().get(`/api/public/employee-cards/${slug}${suffix}`).expect(404);
      }
      // Address remains reserved even while hidden.
      const other = await t.prisma.user.create({
        data: { email: `other-card-${randomUUID()}@ayvo.test`, displayName: 'Other' },
      });
      await http()
        .post(`/api/admin/identity/users/${other.id}/business-card`)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN)
        .send({
          ...action(),
          requestId: randomUUID(),
          expectedVersion: 0,
          slug,
          fields: { ...fields, photoId: null },
        })
        .expect(409);
    });

    it('does not serve a photograph when the card is hidden during storage I/O', async () => {
      version = (await post('/publish').send(action()).expect(200)).body.card.version as number;
      let opened!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = t.storage.get.bind(t.storage);
      const spy = vi.spyOn(t.storage, 'get').mockImplementationOnce(async (key) => {
        opened();
        await gate;
        return original(key);
      });
      const photo = http()
        .get(`/api/public/employee-cards/${slug}/photo?version=${version}`)
        .then((res) => res);
      await started;
      try {
        const hidden = await post('/hide').send(action()).expect(200);
        version = hidden.body.card.version as number;
      } finally {
        release();
      }
      expect((await photo).status).toBe(404);
      spy.mockRestore();
    });

    it('rejects another employee’s private photo and incomplete publication fields', async () => {
      const other = await t.prisma.user.create({
        data: { email: `photo-owner-${randomUUID()}@ayvo.test`, displayName: 'Other photo owner' },
      });
      const png = createCanvas(32, 32).toBuffer('image/png');
      const upload = await http()
        .post(`/api/admin/identity/users/${other.id}/business-card/photos`)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN)
        .field('requestId', randomUUID())
        .attach('file', png, 'photo.png')
        .expect(201);
      await post()
        .send({ ...action(), slug, fields: { ...fields, photoId: upload.body.id } })
        .expect(422);
      await expect(
        t.prisma.employeeCard.update({
          where: { userId: employeeId },
          data: {
            draft: { ...fields, photoId: upload.body.id },
            version: { increment: 1 },
          },
        }),
      ).rejects.toThrow();
      await expect(t.prisma
        .$executeRaw`UPDATE employee_cards SET published = draft, published_version = NULL,
      published_at = now(), version = version + 1 WHERE user_id = ${employeeId}::uuid`).rejects.toThrow();
      await expect(
        t.prisma.employeeCard.update({
          where: { userId: employeeId },
          data: { draft: {}, version: { increment: 1 } },
        }),
      ).rejects.toThrow();
    });

    it('deactivation hides atomically; reactivation never republishes', async () => {
      version = (await post('/publish').send(action()).expect(200)).body.card.version as number;
      await http()
        .post(`/api/admin/identity/users/${employeeId}/deactivate`)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ reason: 'test employee left' })
        .expect(200);
      await http().get(`/api/public/employee-cards/${slug}`).expect(404);
      const row = await t.prisma.employeeCard.findUniqueOrThrow({ where: { userId: employeeId } });
      expect(row.published).toBeNull();
      version = row.version;
      await post('/publish').send(action()).expect(409);
      await http()
        .post(`/api/admin/identity/users/${employeeId}/reactivate`)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ reason: 'test employee returned' })
        .expect(200);
      await http().get(`/api/public/employee-cards/${slug}`).expect(404);
      expect(
        await t.prisma.auditEvent.count({
          where: { type: 'EMPLOYEE_CARD_HIDDEN', targetUserId: employeeId },
        }),
      ).toBeGreaterThanOrEqual(2);
    });

    it('database rejects identity mutation and direct publication for inactive users', async () => {
      await expect(
        t.prisma
          .$executeRaw`UPDATE employee_cards SET slug = 'other-slug', version = version + 1 WHERE user_id = ${employeeId}::uuid`,
      ).rejects.toThrow();
      await expect(
        t.prisma.employeeCard.delete({ where: { userId: employeeId } }),
      ).rejects.toThrow();
      await http()
        .post(`/api/admin/identity/users/${employeeId}/deactivate`)
        .set('Cookie', admin)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ reason: 'test inactive invariant' })
        .expect(200);
      await expect(
        t.prisma.employeeCard.update({
          where: { userId: employeeId },
          data: {
            published: fields,
            publishedAt: new Date(),
            publishedVersion: version + 1,
            version: { increment: 1 },
          },
        }),
      ).rejects.toThrow();
      expect(adminId).not.toBe(employeeId);
    });

    it('fails closed without the anonymous rate-limit store', async () => {
      vi.spyOn(t.redis, 'ready').mockRejectedValueOnce(new Error('fake Redis outage'));
      await http().get(`/api/public/employee-cards/${slug}`).expect(503);
      vi.restoreAllMocks();
    });
  },
);
