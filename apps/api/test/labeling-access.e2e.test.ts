import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  BottleRegistrationResponse,
  LabelingState,
  SiteDetail,
  StationSessionResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  labelingKit,
  registerCrate,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';
import { printedBottles, receiveBottles } from './support/warehouse-fixtures.js';

/**
 * Labelling access through REAL sign-in (PR #23 review): a stored scan result is replayed only to
 * a user who may still work at that station now — not after the role was revoked, the active site
 * switched or the session taken over; and a bottle of another site is refused with nothing
 * written. The superuser app prepares the synthetic catalogue, bottles and stations; the real-auth
 * app runs every station request with the user's session cookie (same database).
 */
describe.skipIf(!hasDatabase)('labelling access and replays (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let kit: LabelingKit;
  let versionId: string;
  let lotId: string;
  let urls: string[];
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => http().post(path).set('Cookie', cookie).send(body),
  });

  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `lab-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Lepič ${randomUUID().slice(0, 4)}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'labelling access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const user = res.body as AdminUserDetail;
    return { id: user.id, cookie: await sessionCookie(ra, user.email) };
  }

  /** A fresh labelling station (superuser) opened, set up and loaded by the given user. */
  async function workingSession(cookie: string) {
    const station = (
      await request(su.app.getHttpServer())
        .post('/api/admin/workstations')
        .send({
          requestId: randomUUID(),
          code: `LAB-${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Lepicí stůl',
          mode: 'LABELING',
          categoryCode: null,
          reason: 'testovací pracoviště',
        })
        .expect(201)
    ).body as { qrUrl: string };
    const opened = await as(cookie).post('/api/admin/station-sessions', {
      requestId: randomUUID(),
      scannedValue: station.qrUrl,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const sessionId = (opened.body as StationSessionResult).session.id;
    const base = `/api/admin/station-sessions/${sessionId}`;
    const ctx = await as(cookie).post(`${base}/labeling-context`, {
      requestId: randomUUID(),
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: lotId,
    });
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    const crate = await as(cookie).post(`${base}/crate`, {
      requestId: randomUUID(),
      scannedValue: await registerCrate(su, kit.crateTypeCode),
    });
    expect(crate.status, JSON.stringify(crate.body)).toBe(200);
    return { sessionId, base, revision: (crate.body as LabelingState).contextRevision };
  }

  const scan = (cookie: string, base: string, url: string, requestId: string, revision: number) =>
    as(cookie).post(`${base}/label-scans`, {
      requestId,
      scannedValue: url,
      contextRevision: revision,
    });

  /** A replay refused for access reasons reveals nothing of the stored result. */
  function expectNoResult(body: Record<string, unknown>) {
    expect(body).not.toHaveProperty('bottle');
    expect(body).not.toHaveProperty('crate');
    expect(body).not.toHaveProperty('cycle');
    expect(body).not.toHaveProperty('sourceLot');
  }

  beforeAll(async () => {
    su = await createTestApp();
    ra = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(ra, {
      email: `lab-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Lab Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    kit = await labelingKit(su);
    const bottles = await printedBottles(su, 6);
    const row = await su.prisma.bottle.findUniqueOrThrow({
      where: { id: bottles[0]!.id },
      include: { creationBatch: true },
    });
    versionId = row.creationBatch.labelTemplateVersionId;
    await approveDesign(su, kit.productCode, versionId);
    lotId = (await receiveBottles(su, 20)).lines[0]!.lot!.id;
    urls = bottles.map((b) => b.url);
  });

  afterAll(async () => {
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
    await su?.close();
  });

  it('a replay after the role was revoked returns no stored result', async () => {
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const { base, revision } = await workingSession(op.cookie);
    const requestId = randomUUID();
    await scan(op.cookie, base, urls[0]!, requestId, revision).expect(200);
    await as(admin)
      .post(`/api/admin/identity/users/${op.id}/roles/revoke`, {
        role: 'PRODUCTION_OPERATOR',
        reason: 'role removed after a scan',
      })
      .expect(200);
    const replay = await scan(op.cookie, base, urls[0]!, requestId, revision);
    expect([replay.status, replay.body.code]).toEqual([403, 'MODE_NOT_PERMITTED']);
    expectNoResult(replay.body);
    expect(
      await su.prisma.bottleEvent.count({
        where: { bottle: { publicToken: urls[0]!.split('/').pop()! }, type: 'LABEL_APPLIED' },
      }),
    ).toBe(1);
  });

  it('a replay after switching the active site returns no stored result', async () => {
    const site = (
      await as(admin).post('/api/admin/sites', {
        code: `PL-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Zakład',
        countryCode: 'PL',
        addressLine1: 'ul. Testowa 1',
        addressLine2: null,
        postalCode: '00-001',
        city: 'Warszawa',
        timeZone: 'Europe/Warsaw',
        defaultLocale: 'pl-PL',
        defaultCurrency: 'PLN',
        capabilities: ['WAREHOUSE', 'PRODUCTION'],
        reason: 'second site',
      })
    ).body as SiteDetail;
    await as(admin).post(`/api/admin/sites/${site.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${site.code}-W`,
      name: 'Magazyn',
      reason: 'first warehouse',
    });
    const op = await createUser(['PRODUCTION_OPERATOR'], [INITIAL_SITE_ID, site.id]);
    await as(op.cookie).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    const { base, revision } = await workingSession(op.cookie);
    const requestId = randomUUID();
    await scan(op.cookie, base, urls[1]!, requestId, revision).expect(200);
    await as(op.cookie).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    const replay = await scan(op.cookie, base, urls[1]!, requestId, revision);
    expect([replay.status, replay.body.code]).toEqual([409, 'STATION_OF_ANOTHER_SITE']);
    expectNoResult(replay.body);
    // Reading the labelling state is refused as well.
    expect((await as(op.cookie).get(`${base}/labeling`)).status).toBe(409);
  });

  it('a replay after a takeover returns no stored result to the former holder', async () => {
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const supervisor = await createUser(['PRODUCTION_SUPERVISOR']);
    const { sessionId, base, revision } = await workingSession(op.cookie);
    const requestId = randomUUID();
    await scan(op.cookie, base, urls[2]!, requestId, revision).expect(200);
    await as(supervisor.cookie)
      .post(`/api/admin/station-sessions/${sessionId}/takeover`, {
        requestId: randomUUID(),
        reason: 'převzetí linky',
      })
      .expect(201);
    const replay = await scan(op.cookie, base, urls[2]!, requestId, revision);
    expect([replay.status, replay.body.code]).toEqual([409, 'SESSION_NOT_OWNED']);
    expectNoResult(replay.body);
    for (const path of ['labeling', 'labeling-options']) {
      expect((await as(op.cookie).get(`${base}/${path}`)).body.code).toBe('SESSION_NOT_OWNED');
    }
  });

  it('refuses a bottle of another site at a normal scan — nothing written', async () => {
    // Bottles registered and printed at another site by the administrator working there.
    const site = (
      await as(admin).post('/api/admin/sites', {
        code: `SK-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Závod',
        countryCode: 'SK',
        addressLine1: 'Testovacia 1',
        addressLine2: null,
        postalCode: '811 01',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE', 'PRODUCTION'],
        reason: 'foreign site',
      })
    ).body as SiteDetail;
    await as(admin).post(`/api/admin/sites/${site.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${site.code}-W`,
      name: 'Sklad',
      reason: 'first warehouse',
    });
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
      await as(admin)
        .post(`/api/admin/label-print-jobs/${reg.printJob!.code}/generate`)
        .expect(200);
      const bottle = await ra.prisma.bottle.findFirstOrThrow({
        where: { creationBatch: { code: reg.batch.code } },
      });
      foreignUrl = `${TEST_QR_BASE_URL}/${bottle.publicToken}`;
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const op = await createUser(['PRODUCTION_OPERATOR']);
    const { base, revision } = await workingSession(op.cookie);
    const counts = async () => ({
      events: await su.prisma.bottleEvent.count(),
      bindings: await su.prisma.bottleProductBinding.count(),
      assignments: await su.prisma.crateAssignment.count(),
      movements: await su.prisma.inventoryMovement.count(),
      cycles: await su.prisma.crateCycle.count(),
    });
    const before = await counts();
    const refused = await scan(op.cookie, base, foreignUrl, randomUUID(), revision);
    expect([refused.status, refused.body.code]).toEqual([422, 'BOTTLE_OF_ANOTHER_SITE']);
    expect(await counts()).toEqual(before);
  });
});
