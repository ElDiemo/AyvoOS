import { randomUUID } from 'node:crypto';
import type { AdminUserDetail, ReturnReceiptDetail, SiteDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { crateFactory, createHotel, hotelBody, type MadeCrate } from './support/order-fixtures.js';
import { deliver, RETURN_ENV, shipCrates } from './support/return-fixtures.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

/**
 * Return intake (doc 047 §4.6 "The site boundary") through REAL sign-in: only ADMIN holds
 * returns:*; a receipt, line or issue of another site is not found — also before a replay; a
 * crate or bottle of another site is never changed and never named; the same requestId must
 * carry the same kind and payload. The superuser app makes the synthetic delivered crates.
 */
describe.skipIf(!hasDatabase)('return intake access and site isolation (real sign-in)', () => {
  let su: TestApp;
  let ra: TestApp;
  let admin: string;
  let adminId: string;
  let other: SiteDetail;
  let crate: MadeCrate;
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
  const open = async () => {
    const r = await as(admin).post('/api/admin/returns/receipts', { hotelCode: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as ReturnReceiptDetail;
  };
  const container = async (code: string) =>
    (
      (await as(admin).post(`/api/admin/returns/receipts/${code}/containers`).expect(200)).body as {
        lineId: string;
      }
    ).lineId;

  beforeAll(async () => {
    su = await createTestApp(RETURN_ENV);
    ra = await createTestApp(RETURN_ENV, {}, { auth: 'real' });
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    const factory = await crateFactory(su, { capacity: 2 });
    const hotel = (await createHotel(su, { name: 'Hotel Hranice' })).code;
    crate = await factory.make();
    await deliver(su, await shipCrates(su, hotel, factory.kit.productCode, [crate]));

    const user = await prepareInvitedUser(ra, {
      email: `returns-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Returns Admin',
    });
    adminId = user.id;
    await ra.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(ra, user.email);
    await activeSite(INITIAL_SITE_ID);
    other = (
      await as(admin).post('/api/admin/sites', {
        code: `RT-${randomUUID().slice(0, 4).toUpperCase()}`,
        name: 'Druhý sklad vratek',
        countryCode: 'SK',
        addressLine1: 'Testovacia 2',
        addressLine2: null,
        postalCode: '811 02',
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

  it('only ADMIN holds returns:*; other roles get 403', async () => {
    const holders = await ra.prisma.rolePermission.findMany({
      where: {
        permissionCode: { in: ['returns:receive', 'returns:correct'] },
        role: { isSystem: true },
      },
      select: { roleCode: true, permissionCode: true },
    });
    expect(holders.map((h) => `${h.roleCode} ${h.permissionCode}`).sort()).toEqual([
      'ADMIN returns:correct',
      'ADMIN returns:receive',
    ]);
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `returns-ws-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Skladník',
      roles: ['WAREHOUSE_SUPERVISOR'],
      siteIds: [INITIAL_SITE_ID],
      warehouseCodes: [],
      reason: 'returns access test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ws = await sessionCookie(ra, (res.body as AdminUserDetail).email);
    await http()
      .post('/api/auth/active-site')
      .set('Cookie', ws)
      .send({ siteId: INITIAL_SITE_ID })
      .expect(200);
    expect((await as(ws).get('/api/admin/returns/receipts')).status).toBe(403);
    expect((await as(ws).post('/api/admin/returns/receipts', { hotelCode: null })).status).toBe(
      403,
    );
  });

  it('another site: its receipts, lines and issues are 404, also before a replay; its crates and bottles are never changed', async () => {
    // At the initial site: a receipt with a line and an issue, and a scan under a known requestId.
    await activeSite(INITIAL_SITE_ID);
    const here = await open();
    const hereLine = await container(here.code);
    const issue = (
      (
        await as(admin).post(
          `/api/admin/returns/receipts/${here.code}/lines/${hereLine}/unreadable`,
        )
      ).body as { issue: { code: string } }
    ).issue.code;
    const rid = randomUUID();
    const scanBody = { requestId: rid, scannedValue: crate.bottleUrls[0]!, outcome: 'GOOD' };
    const first = await as(admin).post(
      `/api/admin/returns/receipts/${here.code}/lines/${hereLine}/bottles`,
      scanBody,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // The same requestId with another line: a conflict, nothing written.
    const otherLine = await container(here.code);
    const conflict = await as(admin).post(
      `/api/admin/returns/receipts/${here.code}/lines/${otherLine}/bottles`,
      scanBody,
    );
    expect([conflict.status, conflict.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    // A hotel of another site is not offered.
    const remoteHotel = (
      await as(admin).post('/api/admin/hotels', hotelBody({ fulfillmentSiteId: other.id }))
    ).body as { code: string };
    const wrongHotel = await as(admin).post('/api/admin/returns/receipts', {
      hotelCode: remoteHotel.code,
    });
    expect([wrongHotel.status, wrongHotel.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);

    // At the other site: none of it exists, the replay included.
    await activeSite(other.id);
    expect((await as(admin).get(`/api/admin/returns/receipts/${here.code}`)).status).toBe(404);
    const replay = await as(admin).post(
      `/api/admin/returns/receipts/${here.code}/lines/${hereLine}/bottles`,
      scanBody,
    );
    expect([replay.status, replay.body.code]).toEqual([404, 'RETURN_RECEIPT_NOT_FOUND']);
    expect(replay.body.details).toBeUndefined();
    for (const [path, body] of [
      [`/api/admin/returns/receipts/${here.code}/lines/${hereLine}/unreadable`, {}],
      [`/api/admin/returns/receipts/${here.code}/lines/${hereLine}/empty`, { physicalCount: 0 }],
      [`/api/admin/returns/receipts/${here.code}/close`, {}],
      [
        `/api/admin/returns/issues/${issue}/identify`,
        { scannedValue: crate.bottleUrls[1]!, outcome: 'GOOD' },
      ],
      [
        `/api/admin/returns/issues/${issue}/close-out`,
        { resolution: 'WRITTEN_OFF', reason: 'cizí' },
      ],
    ] as const) {
      const r = await as(admin).post(path, body);
      expect([r.status, r.body.details], path).toEqual([404, undefined]);
    }
    const listed = (await as(admin).get('/api/admin/returns/receipts').expect(200)).body as {
      items: { code: string }[];
    };
    expect(listed.items.map((i) => i.code)).not.toContain(here.code);
    const overview = (await as(admin).get('/api/admin/returns/overview').expect(200)).body as {
      openIssues: { code: string }[];
    };
    expect(overview.openIssues.map((i) => i.code)).not.toContain(issue);

    // A receipt of the other site: the initial site's crate is refused and stays as it was.
    const there = await open();
    const crateScan = await as(admin).post(`/api/admin/returns/receipts/${there.code}/crates`, {
      scannedValue: crate.crateUrl,
    });
    expect([crateScan.status, crateScan.body.code]).toEqual([409, 'CRATE_OF_ANOTHER_SITE']);
    expect(crateScan.body.details).toBeUndefined();
    const cycle = await ra.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crate.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    expect(cycle.status).toBe('DELIVERED');
    expect(
      (await ra.prisma.orderCrateAllocation.findFirstOrThrow({ where: { cycleId: cycle.id } }))
        .completedAt,
    ).toBeNull();
    // Its bottle: an OTHER_SITE piece without any link to it; the bottle is unchanged.
    const box = await container(there.code);
    const foreign = await as(admin).post(
      `/api/admin/returns/receipts/${there.code}/lines/${box}/bottles`,
      { scannedValue: crate.bottleUrls[1]!, outcome: 'GOOD' },
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(200);
    expect(foreign.body).toMatchObject({
      outcome: 'ISSUE_RECORDED',
      code: 'BOTTLE_OF_ANOTHER_SITE',
      bottleCode: null,
    });
    const again = await as(admin).post(
      `/api/admin/returns/receipts/${there.code}/lines/${box}/bottles`,
      { scannedValue: crate.bottleUrls[1]!, outcome: 'GOOD' },
    );
    expect(again.body).toMatchObject({ repeated: true, issue: foreign.body.issue });
    const detail = (await as(admin).get(`/api/admin/returns/receipts/${there.code}`).expect(200))
      .body as ReturnReceiptDetail;
    const piece = detail.lineDetails.find((l) => l.id === box)!;
    expect(piece.recordedCount).toBe(1);
    expect(piece.issues.map((i) => [i.kind, i.bottleCode, i.details])).toEqual([
      ['OTHER_SITE', null, {}],
    ]);
    const row = await ra.prisma.returnReceiptIssue.findUniqueOrThrow({
      where: { code: foreign.body.issue.code },
    });
    expect(row.bottleId).toBeNull();
    const bottle = await ra.prisma.bottle.findUniqueOrThrow({ where: { id: crate.bottleIds[1]! } });
    expect(bottle.status).toBe('FILLED');
    expect(
      await ra.prisma.bottleEvent.count({ where: { bottleId: bottle.id, type: 'SORTED' } }),
    ).toBe(0);
    // Two operators scan the same foreign piece on the same line at once (different request
    // ids): both held on the receipt, then released together — one piece, one issue.
    const box2 = await container(there.code);
    const receiptRow = await ra.prisma.returnReceipt.findUniqueOrThrow({
      where: { code: there.code },
    });
    const [pending] = await withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "return_receipts" WHERE "id" = ${receiptRow.id}::uuid FOR UPDATE`;
        const scans = [0, 1, 2].map(() =>
          as(admin)
            .post(`/api/admin/returns/receipts/${there.code}/lines/${box2}/bottles`, {
              scannedValue: crate.bottleUrls[0]!,
              outcome: 'GOOD',
            })
            .then((r) => r),
        );
        await new Promise((r) => setTimeout(r, 500));
        return [scans] as const;
      }),
    );
    const raced = await Promise.all(pending);
    expect(raced.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(raced.map((r) => r.body.issue.code)).size).toBe(1);
    expect(
      await ra.prisma.returnReceiptIssue.count({ where: { lineId: box2, kind: 'OTHER_SITE' } }),
    ).toBe(1);
    // OTHER_SITE is closed only as written off.
    const notAyvo = await as(admin).post(`/api/admin/returns/issues/${row.code}/close-out`, {
      resolution: 'NOT_AYVO',
      reason: 'patří jinam',
    });
    expect([notAyvo.status, notAyvo.body.code]).toEqual([409, 'ISSUE_NOT_RESOLVABLE']);
    await activeSite(INITIAL_SITE_ID);
  });
});
