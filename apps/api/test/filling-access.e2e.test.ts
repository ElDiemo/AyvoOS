import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  BottleRegistrationResponse,
  FillingState,
  SiteDetail,
  StationSessionResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';
import { printedBottles, receiveBottles, receiveItem } from './support/warehouse-fixtures.js';

type Printed = Awaited<ReturnType<typeof printedBottles>>[number];

/**
 * Filling and crate corrections through REAL sign-in (doc 025 A4, owner B4): a stored filling
 * result is replayed only to a user who may still fill at that station now; corrections need
 * production:cycle_correct (supervisor/ADMIN, not the operator) and act only on crates of the
 * active site; a bottle of another site is refused at a filling scan with nothing written. The
 * superuser app prepares the synthetic catalogue, crates and stations; the real-auth app runs the
 * users' requests with their session cookies (same database).
 */
describe.skipIf(!hasDatabase)('filling access and corrections (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let kit: LabelingKit;
  let versionId: string;
  let bottleLot: string;
  let liquidLot: string;
  let pool: Printed[];
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });

  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `fill-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Plnič ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'filling access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    return { id: user.id, cookie: await sessionCookie(ra, user.email) };
  }

  /** A crate of 3 labelled bottles (READY_TO_FILL), labelled by the superuser. */
  async function readyCrate() {
    const bottles = pool.splice(0, 3);
    const ls = await labelingSession(su);
    await setContext(su, ls, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: bottleLot,
    }).expect(200);
    const crateUrl = await registerCrate(su, kit.crateTypeCode);
    await loadCrate(su, ls, crateUrl).expect(200);
    for (const b of bottles) expect((await labelScan(su, ls, b.url)).status).toBe(200);
    await request(su.app.getHttpServer())
      .post(`/api/admin/station-sessions/${ls}/release`)
      .send({ requestId: randomUUID() })
      .expect(200);
    const crate = await su.prisma.crate.findUniqueOrThrow({
      where: { qrToken: crateUrl.split('/').pop()! },
    });
    return { crateUrl, crateCode: crate.code, bottles };
  }

  /** A filling station (superuser) opened by the user, the crate loaded and the lot chosen. */
  async function fillingAt(cookie: string, crateUrl: string) {
    const station = (
      await request(su.app.getHttpServer())
        .post('/api/admin/workstations')
        .send({
          requestId: randomUUID(),
          code: `FIL-${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Plnicí linka',
          mode: 'FILLING',
          categoryCode: 'HAND_SOAP',
          reason: 'testovací pracoviště',
        })
        .expect(201)
    ).body as { qrUrl: string };
    const opened = await as(cookie).post('/api/admin/station-sessions', {
      requestId: randomUUID(),
      scannedValue: station.qrUrl,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const base = `/api/admin/station-sessions/${(opened.body as StationSessionResult).session.id}`;
    const loaded = await as(cookie).post(`${base}/filling-crate`, {
      requestId: randomUUID(),
      scannedValue: crateUrl,
    });
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    const lot = await as(cookie).post(`${base}/liquid-lot`, {
      requestId: randomUUID(),
      liquidLotId: liquidLot,
    });
    expect(lot.status, JSON.stringify(lot.body)).toBe(200);
    return { base, revision: (lot.body as FillingState).contextRevision };
  }

  const fill = (cookie: string, base: string, url: string, requestId: string, revision: number) =>
    as(cookie).post(`${base}/fill-scans`, {
      requestId,
      scannedValue: url,
      contextRevision: revision,
    });

  async function secondSite(prefix: string) {
    const site = (
      await as(admin).post('/api/admin/sites', {
        code: `${prefix}-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Druhý závod',
        countryCode: 'SK',
        addressLine1: 'Testovacia 1',
        addressLine2: null,
        postalCode: '811 01',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE', 'PRODUCTION'],
        reason: 'second site',
      })
    ).body as SiteDetail;
    await as(admin).post(`/api/admin/sites/${site.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${site.code}-W`,
      name: 'Sklad',
      reason: 'first warehouse',
    });
    return site;
  }

  beforeAll(async () => {
    su = await createTestApp();
    ra = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(ra, {
      email: `fill-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Fill Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    kit = await labelingKit(su, { capacity: 3 });
    await receiveItem(su, kit.pumpItemId, 100);
    liquidLot = (await receiveItem(su, kit.liquidItemId, 33000)).lines[0]!.lot!.id;
    bottleLot = (await receiveBottles(su, 50)).lines[0]!.lot!.id;
    pool = await printedBottles(su, 20);
    const row = await su.prisma.bottle.findUniqueOrThrow({
      where: { id: pool[0]!.id },
      include: { creationBatch: true },
    });
    versionId = row.creationBatch.labelTemplateVersionId;
    await approveDesign(su, kit.productCode, versionId);
  });

  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
    await su?.close();
  });

  it('a filling replay after the role was revoked returns no stored result', async () => {
    const { crateUrl, bottles } = await readyCrate();
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const { base, revision } = await fillingAt(op.cookie, crateUrl);
    const requestId = randomUUID();
    await fill(op.cookie, base, bottles[0]!.url, requestId, revision).expect(200);
    await as(admin)
      .post(`/api/admin/identity/users/${op.id}/roles/revoke`, {
        role: 'PRODUCTION_OPERATOR',
        reason: 'role removed after a fill',
      })
      .expect(200);
    const replay = await fill(op.cookie, base, bottles[0]!.url, requestId, revision);
    expect([replay.status, replay.body.code]).toEqual([403, 'MODE_NOT_PERMITTED']);
    expect(replay.body).not.toHaveProperty('cycle');
    expect(replay.body).not.toHaveProperty('liquidLot');
    expect(
      await su.prisma.bottleEvent.count({ where: { bottleId: bottles[0]!.id, type: 'FILLED' } }),
    ).toBe(1);
  });

  it('corrections: the operator is refused, the supervisor corrects, another site is not found', async () => {
    const { crateCode, bottles } = await readyCrate();
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const supervisor = await createUser(['PRODUCTION_SUPERVISOR']);
    for (const who of [op, supervisor]) {
      await as(who.cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const body = { requestId: randomUUID(), bottle: bottles[0]!.code, reason: 'vadná lahev' };
    const refused = await as(op.cookie).post(`/api/admin/crates/${crateCode}/remove-bottle`, body);
    expect(refused.status).toBe(403);
    const removed = await as(supervisor.cookie).post(
      `/api/admin/crates/${crateCode}/remove-bottle`,
      body,
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    // The same request id replayed to the operator still needs the permission.
    expect(
      (await as(op.cookie).post(`/api/admin/crates/${crateCode}/remove-bottle`, body)).status,
    ).toBe(403);

    // A crate of another site is "not found" for the supervisor of this site.
    const site = await secondSite('CZB');
    await as(admin).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    let foreignCrate: string;
    try {
      const reg = await as(admin).post('/api/admin/crate-registrations', {
        requestId: randomUUID(),
        crateTypeCode: kit.crateTypeCode,
        quantity: 1,
      });
      expect(reg.status, JSON.stringify(reg.body)).toBe(201);
      foreignCrate = (reg.body as { crateCodes: string[] }).crateCodes[0]!;
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const other = await as(supervisor.cookie).post(
      `/api/admin/crates/${foreignCrate}/abort-cycle`,
      {
        requestId: randomUUID(),
        reason: 'cizí bedna',
      },
    );
    expect(other.status).toBe(404);
  });

  it('refuses a bottle of another site at a filling scan — nothing written', async () => {
    const { crateUrl } = await readyCrate();
    const site = await secondSite('SKF');
    await as(admin).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    let foreignUrl: string;
    try {
      const reg = (
        await as(admin).post('/api/admin/bottle-registrations', {
          requestId: randomUUID(),
          labelTemplateVersionId: versionId,
          quantity: 1,
        })
      ).body as BottleRegistrationResponse;
      const bottle = await ra.prisma.bottle.findFirstOrThrow({
        where: { creationBatch: { code: reg.batch.code } },
      });
      foreignUrl = `${TEST_QR_BASE_URL}/${bottle.publicToken}`;
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const { base, revision } = await fillingAt(op.cookie, crateUrl);
    const counts = async () => ({
      events: await su.prisma.bottleEvent.count(),
      movements: await su.prisma.inventoryMovement.count(),
      cycles: await su.prisma.crateCycle.findMany({ select: { filledCount: true, status: true } }),
    });
    const before = await counts();
    const refused = await fill(op.cookie, base, foreignUrl, randomUUID(), revision);
    expect([refused.status, refused.body.code]).toEqual([422, 'BOTTLE_OF_ANOTHER_SITE']);
    expect(await counts()).toEqual(before);
  });
});
