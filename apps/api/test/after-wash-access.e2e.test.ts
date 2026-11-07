import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, AfterWashQueue, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import { deliver, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * R2 "Po mytí" (doc 048 §2) through REAL sign-in: only ADMIN (returns:receive) scans and reads the
 * queue; a bottle of another site is never changed or named, its queue lists nothing of this
 * site, and a requestId of this site replayed there is a conflict, never this site's result.
 */
describe.skipIf(!hasDatabase)('R2 "Po mytí" access and site isolation (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let other: SiteDetail;
  let crate: MadeCrate;
  let codes: string[];
  const http = () => request(ra.app.getHttpServer());
  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      http()
        .post(path)
        .set('Cookie', cookie)
        .send({ requestId: randomUUID(), ...body }),
  });
  const activeSite = (siteId: string) =>
    http().post('/api/auth/active-site').set('Cookie', admin).send({ siteId }).expect(200);
  const status = async (id: string) =>
    (await ra.prisma.bottle.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    su = await createTestApp(RETURN_ENV);
    ra = await createTestApp(RETURN_ENV, {}, { auth: 'real' });
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    // Two returned bottles of the initial site (the superuser app works there).
    const factory = await crateFactory(su, { capacity: 2 });
    const hotel = (await createHotel(su, { name: 'Hotel Hranice mytí' })).code;
    crate = await factory.make();
    await deliver(su, await shipCrates(su, hotel, factory.kit.productCode, [crate]));
    const api = returnsApi(su);
    const receipt = await api.open();
    const line = (await api.scanCrate(receipt.code, crate.crateUrl)).body.lineId as string;
    for (const url of crate.bottleUrls) await api.scanBottle(receipt.code, line, url).expect(200);
    codes = await Promise.all(
      crate.bottleIds.map(
        async (id) => (await su.prisma.bottle.findUniqueOrThrow({ where: { id } })).code,
      ),
    );

    const user = await prepareInvitedUser(ra, {
      email: `wash-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Wash Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await activeSite(INITIAL_SITE_ID);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `RW-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Druhá myčka',
        countryCode: 'SK',
        addressLine1: 'Testovacia 3',
        addressLine2: null,
        postalCode: '811 03',
        city: 'Bratislava',
        timeZone: 'Europe/Bratislava',
        defaultLocale: 'sk-SK',
        defaultCurrency: 'EUR',
        capabilities: ['WAREHOUSE', 'PRODUCTION'],
        reason: 'second site',
      })
    ).body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${other.id}/warehouses`, {
        code: `${other.code}-W`,
        name: 'Sklad',
        reason: 'first warehouse',
      })
      .expect(201);
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await ra?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await ra?.close();
    await su?.close();
  });

  it('a non-ADMIN role gets 403 for the queue and the scan; nothing changes', async () => {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `wash-ws-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Skladník mytí',
      roles: ['WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'after-wash access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ws = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await http()
      .post('/api/auth/active-site')
      .set('Cookie', ws)
      .send({ siteId: INITIAL_SITE_ID })
      .expect(200);
    expect((await as(ws).get('/api/admin/returns/after-wash')).status).toBe(403);
    const scan = await as(ws).post('/api/admin/returns/after-wash', {
      scannedValue: crate.bottleUrls[0]!,
    });
    expect(scan.status).toBe(403);
    expect(await status(crate.bottleIds[0]!)).toBe('RETURNED');
  });

  it('another site: its queue lists nothing of this site, this site’s bottle is refused without a name, a replay is a conflict', async () => {
    // At the initial site: both bottles wait; one is scanned under a known requestId.
    await activeSite(INITIAL_SITE_ID);
    const here = (await as(admin).get('/api/admin/returns/after-wash').expect(200))
      .body as AfterWashQueue;
    expect(here.waiting.map((w) => w.bottleCode)).toEqual(expect.arrayContaining(codes));
    const rid = randomUUID();
    const body = { requestId: rid, scannedValue: crate.bottleUrls[0]! };
    const first = await as(admin).post('/api/admin/returns/after-wash', body);
    expect([first.status, first.body.outcome], JSON.stringify(first.body)).toEqual([
      200,
      'READY_FOR_REUSE',
    ]);

    // At the other site.
    await activeSite(other.id);
    const there = (await as(admin).get('/api/admin/returns/after-wash').expect(200))
      .body as AfterWashQueue;
    const listed = [...there.waiting, ...there.withdrawn, ...there.ready].map((b) => b.bottleCode);
    for (const code of codes) expect(listed).not.toContain(code);
    // The other bottle of the initial site: refused, not named, unchanged.
    const foreign = await as(admin).post('/api/admin/returns/after-wash', {
      scannedValue: crate.bottleUrls[1]!,
    });
    expect([foreign.status, foreign.body.code, foreign.body.details]).toEqual([
      409,
      'BOTTLE_OF_ANOTHER_SITE',
      undefined,
    ]);
    expect(await status(crate.bottleIds[1]!)).toBe('RETURNED');
    // The initial site's request replayed here: a conflict, never its stored result.
    const replay = await as(admin).post('/api/admin/returns/after-wash', body);
    expect([replay.status, replay.body.code, replay.body.bottleCode]).toEqual([
      409,
      'IDEMPOTENCY_CONFLICT',
      undefined,
    ]);
    expect(
      await ra.prisma.bottleEvent.count({
        where: { bottleId: { in: crate.bottleIds }, type: 'REUSE_READY' },
      }),
    ).toBe(1);
    await activeSite(INITIAL_SITE_ID);
  });
});
