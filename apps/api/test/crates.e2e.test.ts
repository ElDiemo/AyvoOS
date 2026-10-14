import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  CrateDetail,
  CrateLabelPrintJob,
  CratePage,
  CrateRegistration,
  CrateType,
  SiteDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';

/**
 * Physical crates and their QR labels (doc 025 A1, doc 020 §3.4) through the real guard,
 * sessions and database: registration (idempotent, concurrent, validated), the shared QR
 * registry (a token is never both a bottle's and a crate's), immutable history, print jobs with
 * a chosen size and decodable QR codes, reprints with the same URL, the preview, per-site
 * isolation, permissions, the anonymous public page — and that nothing here touches stock.
 */
describe.skipIf(!hasDatabase)('physical crates and crate QR labels', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  let crateType: CrateType;
  let stockBefore: unknown;
  const sfx = () => randomUUID().slice(0, 6).toUpperCase();
  const http = () => request(t.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });
  const binary = (path: string, cookie: string) =>
    http()
      .get(path)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  const stockFingerprint = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } }),
    lots: await t.prisma.inventoryLot.count(),
    bottles: await t.prisma.bottle.count(),
  });

  async function register(cookie: string, quantity: number, requestId = randomUUID()) {
    const res = await as(cookie).post('/api/admin/crate-registrations', {
      requestId,
      crateTypeCode: crateType.code,
      quantity,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as CrateRegistration;
  }

  async function print(cookie: string, crateCodes: string[], widthMm = 100, heightMm = 50) {
    return as(cookie).post('/api/admin/crate-label-print-jobs', {
      requestId: randomUUID(),
      crateCodes,
      widthMm,
      heightMm,
    });
  }

  async function createSite(): Promise<SiteDetail> {
    const res = await as(admin).post('/api/admin/sites', {
      code: `DE-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'Testwerk',
      countryCode: 'DE',
      addressLine1: 'Musterstraße 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      timeZone: 'Europe/Berlin',
      defaultLocale: 'de-DE',
      defaultCurrency: 'EUR',
      capabilities: ['WAREHOUSE', 'PRODUCTION', 'RETURNS'],
      reason: 'crate test site',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as SiteDetail;
  }

  async function createUser(roles: string[], siteIds: string[]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `crates-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Crate Tester',
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'crate test user',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sessionCookie(t, (res.body as AdminUserDetail).email);
  }

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: `crates-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Crate Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    const type = await as(admin).post('/api/admin/catalog/crate-types', {
      requestId: randomUUID(),
      code: `CRATE-${sfx()}`,
      name: 'Vratná bedna 40',
      capacity: 40,
      categoryCodes: ['HAND_SOAP', 'SHOWER_GEL'],
      reason: 'typ bedny pro test',
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    crateType = type.body as CrateType;
    stockBefore = await stockFingerprint();
  });

  afterAll(async () => {
    if (t) expect(await stockFingerprint()).toEqual(stockBefore);
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('registers crates with codes, opaque QR tokens and a REGISTERED event each', async () => {
    const reg = await register(admin, 3);
    expect(reg.code).toMatch(/^CR-\d{6,}$/);
    expect(reg.quantity).toBe(3);
    expect(reg.crateType).toEqual({ code: crateType.code, name: crateType.name, capacity: 40 });
    expect(reg.crateCodes).toHaveLength(3);
    const serials = reg.crateCodes.map((c) => Number(c.slice('AYV-C-'.length)));
    expect(serials).toEqual([serials[0], serials[0]! + 1, serials[0]! + 2]);

    const crates = await t.prisma.crate.findMany({
      where: { code: { in: reg.crateCodes } },
      include: { events: true },
    });
    expect(new Set(crates.map((c) => c.qrToken)).size).toBe(3);
    for (const c of crates) {
      expect(c.qrToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(c.siteId).toBe(INITIAL_SITE_ID);
      expect(c.events.map((e) => e.type)).toEqual(['REGISTERED']);
      expect(c.events[0]!.actorId).toBe(adminId);
      expect(c.events[0]!.locationId).toBeNull();
    }
    const registry = await t.prisma.qrIdentity.findMany({
      where: { token: { in: crates.map((c) => c.qrToken) } },
    });
    expect(registry.map((r) => r.kind)).toEqual(['CRATE', 'CRATE', 'CRATE']);

    const detail = (await as(admin).get(`/api/admin/crates/${reg.crateCodes[0]}`).expect(200))
      .body as CrateDetail;
    const token = crates.find((c) => c.code === reg.crateCodes[0])!.qrToken;
    expect(detail.qrUrl).toBe(`${TEST_QR_BASE_URL}/${token}`);
    expect(detail.lastLocation).toBeNull();
    expect(detail.registrationCode).toBe(reg.code);
    expect(detail.events).toEqual([
      expect.objectContaining({
        type: 'REGISTERED',
        actor: 'Crate Admin',
        registrationCode: reg.code,
      }),
    ]);
    expect(detail.printJobs).toEqual([]);
  });

  it('replays a registration by request id and refuses a changed payload', async () => {
    const requestId = randomUUID();
    const first = await register(admin, 2, requestId);
    const before = await t.prisma.crate.count();
    const replay = await register(admin, 2, requestId);
    expect(replay).toEqual(first);
    expect(await t.prisma.crate.count()).toBe(before);
    const changed = await as(admin).post('/api/admin/crate-registrations', {
      requestId,
      crateTypeCode: crateType.code,
      quantity: 3,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('registers concurrently without duplicate codes and once per request id', async () => {
    const before = await t.prisma.crate.count();
    const results = await Promise.all(Array.from({ length: 8 }, () => register(admin, 2)));
    const codes = results.flatMap((r) => r.crateCodes);
    expect(new Set(codes).size).toBe(16);
    expect(await t.prisma.crate.count()).toBe(before + 16);

    const requestId = randomUUID();
    const same = await Promise.all(
      Array.from({ length: 5 }, () =>
        as(admin).post('/api/admin/crate-registrations', {
          requestId,
          crateTypeCode: crateType.code,
          quantity: 1,
        }),
      ),
    );
    expect(same.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(same.map((r) => (r.body as CrateRegistration).code)).size).toBe(1);
    expect(await t.prisma.crate.count()).toBe(before + 17);
  });

  it('validates registrations', async () => {
    const post = (body: object) =>
      as(admin).post('/api/admin/crate-registrations', { requestId: randomUUID(), ...body });
    expect((await post({ crateTypeCode: crateType.code, quantity: 0 })).status).toBe(400);
    expect((await post({ crateTypeCode: crateType.code, quantity: 1001 })).status).toBe(400);
    expect((await post({ crateTypeCode: crateType.code, quantity: 1.5 })).status).toBe(400);
    const unknown = await post({ crateTypeCode: 'NO-SUCH-TYPE', quantity: 1 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('UNKNOWN_CRATE_TYPE');
  });

  it('keeps one QR registry: every bottle token is registered and no crate can reuse one', async () => {
    const unregistered = await t.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "bottles" b
       WHERE NOT EXISTS (SELECT 1 FROM "qr_identities" q
                          WHERE q."token" = b."public_token" AND q."kind" = 'BOTTLE')`;
    expect(Number(unregistered[0]!.n)).toBe(0);

    const reg = await register(admin, 1);
    const crate = await t.prisma.crate.findUniqueOrThrow({ where: { code: reg.crateCodes[0] } });
    // A token held by a bottle can never be registered for a crate (what the crates insert
    // trigger does first), and a crate token never for a bottle.
    const bottleToken = randomUUID().replace(/-/g, '').slice(0, 22);
    await t.prisma
      .$executeRaw`INSERT INTO "qr_identities" ("token", "kind") VALUES (${bottleToken}, 'BOTTLE')`;
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "qr_identities" ("token", "kind") VALUES (${bottleToken}, 'CRATE')`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "qr_identities" ("token", "kind") VALUES (${crate.qrToken}, 'BOTTLE')`,
    ).rejects.toThrow();
    // A crate row cannot point at a BOTTLE registry entry either (composite FK + kind CHECK).
    await expect(
      t.prisma
        .$executeRaw`UPDATE "crates" SET "qr_token" = ${bottleToken} WHERE "id" = ${crate.id}::uuid`,
    ).rejects.toThrow();
  });

  it('refuses changes to crates, their registry rows and history (append-only)', async () => {
    const reg = await register(admin, 1);
    const crate = await t.prisma.crate.findUniqueOrThrow({ where: { code: reg.crateCodes[0] } });
    await expect(
      t.prisma.$executeRaw`UPDATE "crates" SET "status" = 'RETIRED' WHERE "id" = ${crate.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRaw`DELETE FROM "crate_events" WHERE "crate_id" = ${crate.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`UPDATE "qr_identities" SET "kind" = 'BOTTLE' WHERE "token" = ${crate.qrToken}`,
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRaw`DELETE FROM "crate_registrations" WHERE "code" = ${reg.code}`,
    ).rejects.toThrow();
  });

  it('prints crate labels at the chosen size with decodable QR codes and the DEV marker', async () => {
    const reg = await register(admin, 2);
    const res = await print(admin, reg.crateCodes, 100, 50);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const job = res.body as CrateLabelPrintJob;
    expect(job).toMatchObject({
      status: 'COMPLETED',
      labelCount: 2,
      widthMm: 100,
      heightMm: 50,
      crateCodes: reg.crateCodes,
      createdBy: 'Crate Admin',
      environment: 'test',
    });
    expect(job.code).toMatch(/^PJ-\d{6,}$/);
    expect(job.downloadUrl).toBe(`/api/admin/crate-label-print-jobs/${job.code}/pdf`);

    const pdfRes = await binary(job.downloadUrl!, admin).expect(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    const pdf = await openPdf(pdfRes.body as Buffer);
    expect(pdf.pageCount).toBe(2);
    const tokens = await t.prisma.crate.findMany({
      where: { code: { in: reg.crateCodes } },
      orderBy: { serial: 'asc' },
    });
    for (let page = 1; page <= 2; page++) {
      expect(pdf.pageSizesMm[page - 1]!.widthMm).toBeCloseTo(100, 1);
      expect(pdf.pageSizesMm[page - 1]!.heightMm).toBeCloseTo(50, 1);
      expect((await decodeQrOnPage(pdf, page, 8))?.data).toBe(
        `${TEST_QR_BASE_URL}/${tokens[page - 1]!.qrToken}`,
      );
      const text = await pageText(pdf, page);
      expect(text).toContain(reg.crateCodes[page - 1]);
      expect(text).toContain(`${crateType.code} · Kapacita 40`);
      expect(text).toContain('DEV - NOT FOR PRODUCTION');
    }
  });

  it('reprints with the same token and URL as a new job, recorded in the crate history', async () => {
    const reg = await register(admin, 1);
    const code = reg.crateCodes[0]!;
    const first = (await print(admin, [code], 100, 50)).body as CrateLabelPrintJob;
    const second = (await print(admin, [code], 60, 60)).body as CrateLabelPrintJob;
    expect(second.code).not.toBe(first.code);
    expect(second.status).toBe('COMPLETED');

    const urls = [];
    for (const job of [first, second]) {
      const pdf = await openPdf((await binary(job.downloadUrl!, admin).expect(200)).body as Buffer);
      urls.push((await decodeQrOnPage(pdf, 1, 8))?.data);
    }
    const crate = await t.prisma.crate.findUniqueOrThrow({ where: { code } });
    expect(urls).toEqual([
      `${TEST_QR_BASE_URL}/${crate.qrToken}`,
      `${TEST_QR_BASE_URL}/${crate.qrToken}`,
    ]);
    expect(await t.prisma.crate.count({ where: { code } })).toBe(1);

    const detail = (await as(admin).get(`/api/admin/crates/${code}`).expect(200))
      .body as CrateDetail;
    expect(detail.events.map((e) => [e.type, e.printJobCode])).toEqual([
      ['REGISTERED', null],
      ['LABEL_PRINT_JOB_CREATED', first.code],
      ['LABEL_PRINT_JOB_CREATED', second.code],
    ]);
    expect(detail.printJobs.map((j) => j.code)).toEqual([second.code, first.code]);
  });

  it('replays a print request by request id without a second job', async () => {
    const reg = await register(admin, 1);
    const body = { requestId: randomUUID(), crateCodes: reg.crateCodes, widthMm: 80, heightMm: 40 };
    const a = await as(admin).post('/api/admin/crate-label-print-jobs', body).expect(201);
    const b = await as(admin).post('/api/admin/crate-label-print-jobs', body).expect(201);
    expect((b.body as CrateLabelPrintJob).code).toBe((a.body as CrateLabelPrintJob).code);
    expect(
      await t.prisma.crateLabelPrintJobItem.count({
        where: { crate: { code: reg.crateCodes[0] } },
      }),
    ).toBe(1);
  });

  it('refuses a label too small for a readable QR and records nothing', async () => {
    const reg = await register(admin, 1);
    const before = await t.prisma.crateLabelPrintJob.count();
    const res = await print(admin, reg.crateCodes, 20, 20);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LABEL_TOO_SMALL');
    expect((await print(admin, reg.crateCodes, 301, 50)).status).toBe(400);
    expect(await t.prisma.crateLabelPrintJob.count()).toBe(before);
  });

  it('marks a failed rendering FAILED with a safe reason and renders it on retry', async () => {
    const reg = await register(admin, 1);
    t.storage.failPutsRemaining = 1;
    const failed = (await print(admin, reg.crateCodes)).body as CrateLabelPrintJob;
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toBe('PDF generation failed. Retry the generation.');
    expect(failed.downloadUrl).toBeNull();
    const retried = (
      await as(admin).post(`/api/admin/crate-label-print-jobs/${failed.code}/generate`).expect(200)
    ).body as CrateLabelPrintJob;
    expect(retried.status).toBe('COMPLETED');
    expect(retried.attempts).toBe(2);
    const again = await as(admin).post(`/api/admin/crate-label-print-jobs/${failed.code}/generate`);
    expect(again.status).toBe(409);
  });

  it('previews a size with a placeholder QR, marked PREVIEW, without recording anything', async () => {
    const jobs = await t.prisma.crateLabelPrintJob.count();
    const events = await t.prisma.crateEvent.count();
    const res = await binary(
      `/api/admin/crate-label-preview?widthMm=70&heightMm=40&crateType=${crateType.code}`,
      admin,
    ).expect(200);
    const pdf = await openPdf(res.body as Buffer);
    expect(pdf.pageCount).toBe(1);
    expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(70, 1);
    const text = await pageText(pdf, 1);
    expect(text).toContain('PREVIEW');
    expect(text).toContain(`${crateType.code} · Kapacita 40`);
    const qr = await decodeQrOnPage(pdf, 1, 8);
    expect(qr?.data.startsWith('https://qr.invalid/')).toBe(true);
    expect(await t.prisma.crateLabelPrintJob.count()).toBe(jobs);
    expect(await t.prisma.crateEvent.count()).toBe(events);
    const small = await as(admin).get('/api/admin/crate-label-preview?widthMm=20&heightMm=20');
    expect(small.status).toBe(422);
  });

  it('lists crates of the active site with search and type filter', async () => {
    const reg = await register(admin, 2);
    const page = (await as(admin).get('/api/admin/crates?pageSize=100').expect(200))
      .body as CratePage;
    expect(page.items.map((c) => c.code)).toEqual(expect.arrayContaining(reg.crateCodes));
    expect(page.items.every((c) => c.site.code && c.lastLocation === null)).toBe(true);

    const number = reg.crateCodes[1]!.slice('AYV-C-'.length);
    const found = (
      await as(admin)
        .get(`/api/admin/crates?search=${Number(number)}`)
        .expect(200)
    ).body as CratePage;
    expect(found.items.map((c) => c.code)).toEqual([reg.crateCodes[1]]);
    const none = (await as(admin).get('/api/admin/crates?search=xyz').expect(200))
      .body as CratePage;
    expect(none.total).toBe(0);
    const byType = (await as(admin).get(`/api/admin/crates?crateType=NO-SUCH-TYPE`).expect(200))
      .body as CratePage;
    expect(byType.total).toBe(0);
  });

  it('isolates crates, history and print jobs per site', async () => {
    const reg = await register(admin, 1);
    const own = reg.crateCodes[0]!;
    const job = (await print(admin, [own])).body as CrateLabelPrintJob;

    const site = await createSite();
    await as(admin).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    try {
      const list = (await as(admin).get('/api/admin/crates?pageSize=100').expect(200))
        .body as CratePage;
      expect(list.items.map((c) => c.code)).not.toContain(own);
      expect((await as(admin).get(`/api/admin/crates/${own}`)).status).toBe(404);
      const foreign = await print(admin, [own]);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('CRATE_NOT_FOUND');
      expect((await as(admin).get(`/api/admin/crate-label-print-jobs/${job.code}`)).status).toBe(
        404,
      );
      expect(
        (await as(admin).get(`/api/admin/crate-label-print-jobs/${job.code}/pdf`)).status,
      ).toBe(404);

      const there = await register(admin, 1);
      expect(there.site.code).toBe(site.code);
      const listThere = (await as(admin).get('/api/admin/crates').expect(200)).body as CratePage;
      expect(listThere.items.map((c) => c.code)).toEqual(there.crateCodes);
      // A job never mixes sites, even when the crates are named explicitly.
      const mixed = await print(admin, [there.crateCodes[0]!, own]);
      expect(mixed.status).toBe(404);
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
  });

  it('enforces crates:read and crates:register server-side', async () => {
    const reg = await register(admin, 1);
    const job = (await print(admin, reg.crateCodes)).body as CrateLabelPrintJob;
    const warehouseOperator = await createUser(['WAREHOUSE_OPERATOR'], [INITIAL_SITE_ID]);
    const productionOperator = await createUser(['PRODUCTION_OPERATOR'], [INITIAL_SITE_ID]);
    const supervisor = await createUser(['WAREHOUSE_SUPERVISOR'], [INITIAL_SITE_ID]);

    for (const reader of [warehouseOperator, productionOperator]) {
      await as(reader).get('/api/admin/crates').expect(200);
      await as(reader).get(`/api/admin/crates/${reg.crateCodes[0]}`).expect(200);
      await binary(`/api/admin/crate-label-print-jobs/${job.code}/pdf`, reader).expect(200);
      const denied = [
        await as(reader).post('/api/admin/crate-registrations', {
          requestId: randomUUID(),
          crateTypeCode: crateType.code,
          quantity: 1,
        }),
        await print(reader, reg.crateCodes),
        await as(reader).post(`/api/admin/crate-label-print-jobs/${job.code}/generate`),
        await as(reader).get('/api/admin/crate-label-preview?widthMm=70&heightMm=40'),
      ];
      expect(denied.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    }
    const byWarehouseSupervisor = await register(supervisor, 1);
    expect(byWarehouseSupervisor.crateCodes).toHaveLength(1);
    expect((await print(supervisor, byWarehouseSupervisor.crateCodes)).status).toBe(201);
    expect((await http().get('/api/admin/crates')).status).toBe(401);
  });

  it('shows only "an AYVO returnable crate" publicly — nothing internal', async () => {
    const reg = await register(admin, 1);
    const crate = await t.prisma.crate.findUniqueOrThrow({ where: { code: reg.crateCodes[0] } });
    const res = await http().get(`/api/public/crates/${crate.qrToken}`).expect(200);
    expect(res.body).toEqual({ kind: 'AYVO_RETURNABLE_CRATE' });
    expect(JSON.stringify(res.body)).not.toContain(crate.code);
    await http()
      .get(`/api/public/crates/${'A'.repeat(22)}`)
      .expect(404);
    await http().get('/api/public/crates/not-a-token').expect(404);
    // A crate token is not a bottle passport.
    await http().get(`/api/public/bottles/${crate.qrToken}`).expect(404);
  });
});
