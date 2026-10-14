import { randomUUID } from 'node:crypto';
import type {
  AdminUserDetail,
  CurrentStationSession,
  ManagedWorkstation,
  SiteDetail,
  StationSessionResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';
import { INITIAL_SITE_ID, prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';

/**
 * Workstations and work sessions (doc 026, A2) through the real guard, sessions and database:
 * management with reasons and events, the station QR (registry, label PDF, public page), mode
 * permissions, resume, voluntary handover, forced takeover, one active session per station and
 * per user under concurrency, deactivation, per-site isolation and the database invariants.
 */
describe.skipIf(!hasDatabase)('workstations and work sessions', () => {
  let t: TestApp;
  let adminId: string;
  let admin: string;
  let supervisor: string;
  let operator: string;
  let operator2: string;
  let operator3: string;
  let warehouseOperator: string;
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

  async function createUser(roles: string[], siteIds = [INITIAL_SITE_ID]) {
    const res = await as(admin).post('/api/admin/identity/users', {
      email: `ws-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: `Pracovník ${sfx()}`,
      roles,
      siteIds,
      warehouseCodes: [],
      reason: 'workstation test user',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sessionCookie(t, (res.body as AdminUserDetail).email);
  }

  async function station(
    cookie = admin,
    body: Partial<{ mode: string; categoryCode: string | null; code: string }> = {},
  ): Promise<ManagedWorkstation> {
    const res = await as(cookie).post('/api/admin/workstations', {
      requestId: randomUUID(),
      code: `WS-${sfx()}`,
      name: 'Plnicí linka gel',
      mode: 'FILLING',
      categoryCode: 'SHOWER_GEL',
      reason: 'nové pracoviště',
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ManagedWorkstation;
  }

  const open = (cookie: string, scannedValue: string, requestId = randomUUID()) =>
    as(cookie).post('/api/admin/station-sessions', { requestId, scannedValue });
  const release = (cookie: string, id: string) =>
    as(cookie).post(`/api/admin/station-sessions/${id}/release`, { requestId: randomUUID() });

  beforeAll(async () => {
    t = await createTestApp({}, {}, { auth: 'real' });
    const user = await prepareInvitedUser(t, {
      email: `ws-admin-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Station Admin',
    });
    adminId = user.id;
    await t.prisma.userRole.create({
      data: { userId: user.id, roleCode: 'ADMIN', grantReason: 'test administrator' },
    });
    admin = await sessionCookie(t, user.email);
    await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    [supervisor, operator, operator2, operator3, warehouseOperator] = await Promise.all([
      createUser(['PRODUCTION_SUPERVISOR']),
      createUser(['PRODUCTION_OPERATOR']),
      createUser(['PRODUCTION_OPERATOR']),
      createUser(['PRODUCTION_OPERATOR']),
      createUser(['WAREHOUSE_OPERATOR']),
    ]);
  });

  afterAll(async () => {
    await t?.prisma.userRole.updateMany({
      where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'end of test' },
    });
    await t?.close();
  });

  it('creates stations with a registered QR, an event and validation; only managers may', async () => {
    const ws = await station(supervisor);
    expect(ws).toMatchObject({
      mode: 'FILLING',
      category: { code: 'SHOWER_GEL' },
      status: 'ACTIVE',
      activeSession: null,
    });
    expect(ws.qrUrl).toMatch(new RegExp(`^${TEST_QR_BASE_URL}/[A-Za-z0-9_-]{22}$`));
    const row = await t.prisma.workstation.findUniqueOrThrow({
      where: { code: ws.code },
      include: { events: true },
    });
    expect(row.events.map((e) => e.type)).toEqual(['CREATED']);
    expect(await t.prisma.qrIdentity.findUnique({ where: { token: row.qrToken } })).toMatchObject({
      kind: 'WORKSTATION',
    });

    const labelling = await station(admin, { mode: 'LABELING', categoryCode: null });
    expect(labelling.category).toBeNull();

    const post = (cookie: string, body: object) =>
      as(cookie).post('/api/admin/workstations', {
        requestId: randomUUID(),
        code: `WS-${sfx()}`,
        name: 'x',
        reason: 'test',
        ...body,
      });
    expect((await post(admin, { mode: 'FILLING', categoryCode: null })).status).toBe(400);
    expect((await post(admin, { mode: 'LABELING', categoryCode: 'HAND_SOAP' })).status).toBe(400);
    const unknown = await post(admin, { mode: 'FILLING', categoryCode: 'NO_SUCH' });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'UNKNOWN_CATEGORY']);
    const taken = await post(admin, { mode: 'FILLING', categoryCode: 'HAND_SOAP', code: ws.code });
    expect([taken.status, taken.body.code]).toEqual([409, 'CODE_TAKEN']);
    expect((await post(operator, { mode: 'FILLING', categoryCode: 'HAND_SOAP' })).status).toBe(403);
    expect((await as(operator).get('/api/admin/workstations')).status).toBe(403);

    const requestId = randomUUID();
    const body = {
      requestId,
      code: `WS-${sfx()}`,
      name: 'Opakovaný',
      mode: 'FILLING',
      categoryCode: 'HAND_SOAP',
      reason: 'test',
    };
    const first = await as(admin).post('/api/admin/workstations', body).expect(201);
    const replay = await as(admin).post('/api/admin/workstations', body).expect(201);
    expect(replay.body).toEqual(first.body);
  });

  it('prints the station QR label and keeps the public page empty of internals', async () => {
    const ws = await station();
    const res = await binary(
      `/api/admin/workstations/${ws.code}/qr-label?widthMm=70&heightMm=40`,
      admin,
    ).expect(200);
    const pdf = await openPdf(res.body as Buffer);
    expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(70, 1);
    expect((await decodeQrOnPage(pdf, 1, 12))?.data).toBe(ws.qrUrl);
    const text = await pageText(pdf, 1);
    expect(text).toContain(ws.code);
    expect(text).toContain('PLNENI · SHOWER_GEL');
    expect(text).toContain('DEV - NOT FOR PRODUCTION');
    expect(
      (await as(admin).get(`/api/admin/workstations/${ws.code}/qr-label?widthMm=20&heightMm=20`))
        .status,
    ).toBe(422);

    const token = ws.qrUrl.split('/').pop()!;
    const pub = await http().get(`/api/public/workstations/${token}`).expect(200);
    expect(pub.body).toEqual({ kind: 'AYVO_INTERNAL_MARK' });
    await http().get(`/api/public/crates/${token}`).expect(404);
    await http().get(`/api/public/bottles/${token}`).expect(404);
  });

  it('opens by scanning, resumes the own session and checks the mode permission', async () => {
    const filling = await station();
    const labelling = await station(admin, { mode: 'LABELING', categoryCode: null });

    const opened = await open(operator3, filling.qrUrl).expect(201);
    const result = opened.body as StationSessionResult;
    expect(result.outcome).toBe('OPENED');
    expect(result.station).toMatchObject({ code: filling.code, mode: 'FILLING' });
    const lease = new Date(result.session.leaseExpiresAt).getTime() - Date.now();
    expect(lease).toBeGreaterThan(14 * 60_000);
    expect(lease).toBeLessThanOrEqual(15 * 60_000);

    const resumed = (await open(operator3, `${filling.qrUrl}\r\n`).expect(201))
      .body as StationSessionResult;
    expect([resumed.outcome, resumed.session.id]).toEqual(['RESUMED', result.session.id]);
    const current = (await as(operator3).get('/api/admin/station-sessions/current').expect(200))
      .body as CurrentStationSession;
    expect(current.current?.session.id).toBe(result.session.id);
    await release(operator3, result.session.id).expect(200);

    // Operators do not hold production:label_apply in A2 (granted with labelling, A3).
    const mode = await open(operator3, labelling.qrUrl);
    expect([mode.status, mode.body.code]).toEqual([403, 'MODE_NOT_PERMITTED']);
    const wh = await open(warehouseOperator, filling.qrUrl);
    expect([wh.status, wh.body.code]).toEqual([403, 'MODE_NOT_PERMITTED']);
    // A supervisor may open a labelling station.
    const sup = (await open(supervisor, labelling.qrUrl).expect(201)).body as StationSessionResult;
    await release(supervisor, sup.session.id).expect(200);
  });

  it('refuses everything that is not this environment’s active station, without writing', async () => {
    const before = await t.prisma.workstationSession.count();
    const crate = await as(admin).post('/api/admin/catalog/crate-types', {
      requestId: randomUUID(),
      code: `CRATE-${sfx()}`,
      name: 'Bedna',
      capacity: 40,
      categoryCodes: ['HAND_SOAP'],
      reason: 'typ bedny pro test',
    });
    const reg = await as(admin).post('/api/admin/crate-registrations', {
      requestId: randomUUID(),
      crateTypeCode: crate.body.code,
      quantity: 1,
    });
    const crateRow = await t.prisma.crate.findUniqueOrThrow({
      where: { code: reg.body.crateCodes[0] },
    });
    const cases: [string, string][] = [
      [`${TEST_QR_BASE_URL}/${crateRow.qrToken}`, 'NOT_A_STATION'],
      [`${TEST_QR_BASE_URL}/${'Z'.repeat(22)}`, 'UNKNOWN_STATION'],
      ['hello', 'NOT_AYVO_QR'],
      [`https://qr.ayvo.co/${'A'.repeat(22)}`, 'WRONG_ENVIRONMENT'],
    ];
    for (const [value, code] of cases) {
      const res = await open(operator, value);
      expect([res.status, res.body.code], value).toEqual([422, code]);
    }
    // A modified request cannot smuggle a category or site in.
    const ws = await station();
    const smuggled = await as(operator).post('/api/admin/station-sessions', {
      requestId: randomUUID(),
      scannedValue: ws.qrUrl,
      categoryCode: 'HAND_SOAP',
    });
    expect(smuggled.status).toBe(400);
    expect(await t.prisma.workstationSession.count()).toBe(before);
  });

  it('refuses a station in use with its holder; the holder hands over voluntarily', async () => {
    const ws = await station();
    const held = (await open(operator, ws.qrUrl).expect(201)).body as StationSessionResult;

    const busy = await open(operator2, ws.qrUrl);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('STATION_IN_USE');
    expect(busy.body.details).toMatchObject({
      sessionId: held.session.id,
      holder: held.session.user,
      leaseExpired: false,
    });
    // An operator may not force a takeover.
    const forced = await as(operator2).post(
      `/api/admin/station-sessions/${held.session.id}/takeover`,
      { requestId: randomUUID(), reason: 'chci převzít' },
    );
    expect(forced.status).toBe(403);

    // Voluntary handover: the holder leaves, the next operator scans — no supervisor.
    await release(operator, held.session.id).expect(200);
    const next = (await open(operator2, ws.qrUrl).expect(201)).body as StationSessionResult;
    expect(next.outcome).toBe('OPENED');
    expect((await release(operator, held.session.id)).body.code).toBe('SESSION_NOT_OWNED');
    await release(operator2, next.session.id).expect(200);
  });

  it('lets a supervisor take over with a reason; the former holder learns it', async () => {
    const ws = await station();
    const held = (await open(operator, ws.qrUrl).expect(201)).body as StationSessionResult;
    const takeover = (body: object) =>
      as(supervisor).post(`/api/admin/station-sessions/${held.session.id}/takeover`, {
        requestId: randomUUID(),
        ...body,
      });
    expect((await takeover({})).status).toBe(400);
    const taken = (await takeover({ reason: 'operátor odešel domů' }).expect(201))
      .body as StationSessionResult;
    expect(taken.outcome).toBe('TAKEN_OVER');
    expect(taken.station.code).toBe(ws.code);

    const stale = await as(operator).post(
      `/api/admin/station-sessions/${held.session.id}/heartbeat`,
    );
    expect([stale.status, stale.body.code]).toEqual([409, 'SESSION_NOT_OWNED']);
    const told = (await as(operator).get('/api/admin/station-sessions/current').expect(200))
      .body as CurrentStationSession;
    expect(told.current).toBeNull();
    expect(told.endedByOther).toMatchObject({
      status: 'TAKEN_OVER',
      reason: 'operátor odešel domů',
      station: { code: ws.code },
    });
    const events = await t.prisma.workstationSessionEvent.findMany({
      where: { sessionId: held.session.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['OPENED', 'TAKEN_OVER']);
    expect(
      await t.prisma.auditEvent.count({
        where: { type: 'STATION_SESSION_TAKEN_OVER', reason: 'operátor odešel domů' },
      }),
    ).toBe(1);
    await release(supervisor, taken.session.id).expect(200);
  });

  it('keeps one active session per user: another station needs leaving first', async () => {
    const [a, b] = [await station(), await station()];
    const first = (await open(operator, a.qrUrl).expect(201)).body as StationSessionResult;
    const elsewhere = await open(operator, b.qrUrl);
    expect([elsewhere.status, elsewhere.body.code]).toEqual([409, 'SESSION_ELSEWHERE']);
    expect(elsewhere.body.details).toEqual({ station: { code: a.code, name: a.name } });
    await release(operator, first.session.id).expect(200);
    const moved = (await open(operator, b.qrUrl).expect(201)).body as StationSessionResult;
    await release(operator, moved.session.id).expect(200);
  });

  it('holds under concurrency: one session per station and per user', async () => {
    const ws = await station();
    const users = [operator, operator2, operator3, supervisor, admin];
    const raced = await Promise.all(users.map((u) => open(u, ws.qrUrl)));
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual([
      'STATION_IN_USE',
      'STATION_IN_USE',
      'STATION_IN_USE',
      'STATION_IN_USE',
    ]);
    const winner = raced.find((r) => r.status === 201)!.body as StationSessionResult;
    const winnerCookie = users[raced.findIndex((r) => r.status === 201)]!;
    await release(winnerCookie, winner.session.id).expect(200);

    const three = [await station(), await station(), await station()];
    const mine = await Promise.all(three.map((s) => open(operator2, s.qrUrl)));
    expect(mine.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      mine.filter((r) => r.status === 409).every((r) => r.body.code === 'SESSION_ELSEWHERE'),
    ).toBe(true);
    const won = mine.find((r) => r.status === 201)!.body as StationSessionResult;
    expect(
      await t.prisma.workstationSession.count({
        where: { status: 'ACTIVE', workstation: { code: { in: three.map((x) => x.code) } } },
      }),
    ).toBe(1);
    await release(operator2, won.session.id).expect(200);
  });

  it('deactivation ends the active session with its reason; reactivation reopens the station', async () => {
    const ws = await station();
    const held = (await open(operator, ws.qrUrl).expect(201)).body as StationSessionResult;
    const change = (path: string, body: object) =>
      as(supervisor).post(`/api/admin/workstations/${ws.code}/${path}`, {
        requestId: randomUUID(),
        ...body,
      });
    expect((await change('deactivate', {})).status).toBe(400);
    const off = (await change('deactivate', { reason: 'linka v opravě' }).expect(200))
      .body as ManagedWorkstation;
    expect([off.status, off.activeSession]).toEqual(['INACTIVE', null]);
    const session = await t.prisma.workstationSession.findUniqueOrThrow({
      where: { id: held.session.id },
    });
    expect([session.status, session.closeReason]).toEqual(['CLOSED', 'linka v opravě']);
    const refused = await open(operator, ws.qrUrl);
    expect([refused.status, refused.body.code]).toEqual([409, 'STATION_INACTIVE']);
    expect((await change('deactivate', { reason: 'znovu' })).body.code).toBe('ALREADY_INACTIVE');

    await change('reactivate', { reason: 'linka opravena' }).expect(200);
    const again = (await open(operator, ws.qrUrl).expect(201)).body as StationSessionResult;
    await release(operator, again.session.id).expect(200);
    const events = await t.prisma.workstationEvent.findMany({
      where: { workstation: { code: ws.code } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['CREATED', 'DEACTIVATED', 'REACTIVATED']);
  });

  it('isolates stations per site', async () => {
    const site = await as(admin).post('/api/admin/sites', {
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
      capabilities: ['WAREHOUSE', 'PRODUCTION'],
      reason: 'station test site',
    });
    const other = site.body as SiteDetail;
    await as(admin).post(`/api/admin/sites/${other.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${other.code}-W`,
      name: 'Sklad',
      reason: 'first warehouse',
    });
    await as(admin).post('/api/auth/active-site', { siteId: other.id }).expect(200);
    let foreign: ManagedWorkstation;
    try {
      foreign = await station();
      expect(foreign.site.code).toBe(other.code);
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const list = (await as(admin).get('/api/admin/workstations').expect(200))
      .body as ManagedWorkstation[];
    expect(list.map((w) => w.code)).not.toContain(foreign.code);
    expect(
      (
        await as(admin).get(
          `/api/admin/workstations/${foreign.code}/qr-label?widthMm=70&heightMm=40`,
        )
      ).status,
    ).toBe(404);
    const scan = await open(operator, foreign.qrUrl);
    expect([scan.status, scan.body.code]).toEqual([409, 'STATION_OF_ANOTHER_SITE']);
  });

  it('never offers a stale station context: site switch, lost permission, lost PRODUCTION', async () => {
    // A user with two sites opens a station at the first one, then switches the active site.
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
        reason: 'second site for scope tests',
      })
    ).body as SiteDetail;
    await as(admin).post(`/api/admin/sites/${site.id}/warehouses`, {
      requestId: randomUUID(),
      code: `${site.code}-W`,
      name: 'Magazyn',
      reason: 'first warehouse',
    });
    const created = await as(admin).post('/api/admin/identity/users', {
      email: `ws-multi-${randomUUID().slice(0, 8)}@ayvo.test`,
      displayName: 'Dvě provozovny',
      roles: ['PRODUCTION_OPERATOR'],
      siteIds: [INITIAL_SITE_ID, site.id],
      warehouseCodes: [],
      reason: 'two-site operator',
    });
    const multiUser = created.body as AdminUserDetail;
    const multi = await sessionCookie(t, multiUser.email);
    await as(multi).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    const ws = await station();
    const held = (await open(multi, ws.qrUrl).expect(201)).body as StationSessionResult;

    await as(multi).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    const switched = (await as(multi).get('/api/admin/station-sessions/current').expect(200))
      .body as CurrentStationSession;
    expect(switched).toEqual({
      current: null,
      blocked: { sessionId: held.session.id, code: 'STATION_OF_ANOTHER_SITE' },
      endedByOther: null,
    });
    const beat = await as(multi).post(`/api/admin/station-sessions/${held.session.id}/heartbeat`);
    expect([beat.status, beat.body.code]).toEqual([409, 'STATION_OF_ANOTHER_SITE']);
    // Leaving stays possible (cleanup), so a scope change never locks the user in.
    await release(multi, held.session.id).expect(200);

    // Lost mode permission: the role is revoked while a session is open.
    await as(multi).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    const again = (await open(multi, ws.qrUrl).expect(201)).body as StationSessionResult;
    await as(admin)
      .post(`/api/admin/identity/users/${multiUser.id}/roles/revoke`, {
        role: 'PRODUCTION_OPERATOR',
        reason: 'role removed during work',
      })
      .expect(200);
    const revoked = (await as(multi).get('/api/admin/station-sessions/current').expect(200))
      .body as CurrentStationSession;
    expect([revoked.current, revoked.blocked?.code]).toEqual([null, 'MODE_NOT_PERMITTED']);
    expect(
      (await as(multi).post(`/api/admin/station-sessions/${again.session.id}/heartbeat`)).status,
    ).toBe(403);
    await release(multi, again.session.id).expect(200);

    // The site stops producing (capability removed through the real site administration).
    await as(admin).post('/api/auth/active-site', { siteId: site.id }).expect(200);
    let foreign: ManagedWorkstation;
    try {
      foreign = await station();
    } finally {
      await as(admin).post('/api/auth/active-site', { siteId: INITIAL_SITE_ID }).expect(200);
    }
    const plOperator = await createUser(
      ['PRODUCTION_OPERATOR', 'PRODUCTION_SUPERVISOR'],
      [site.id],
    );
    const plHeld = (await open(plOperator, foreign.qrUrl).expect(201)).body as StationSessionResult;
    const detail = (await as(admin).get(`/api/admin/sites/${site.id}`).expect(200))
      .body as SiteDetail;
    await as(admin)
      .post(`/api/admin/sites/${site.id}`, {
        name: detail.name,
        countryCode: detail.countryCode,
        addressLine1: detail.addressLine1,
        addressLine2: detail.addressLine2,
        postalCode: detail.postalCode,
        city: detail.city,
        timeZone: detail.timeZone,
        defaultLocale: detail.defaultLocale,
        defaultCurrency: detail.defaultCurrency,
        capabilities: ['WAREHOUSE'],
        reason: 'site stops producing',
      })
      .expect(200);
    const noProd = (await as(plOperator).get('/api/admin/station-sessions/current').expect(200))
      .body as CurrentStationSession;
    expect([noProd.current, noProd.blocked?.code]).toEqual([null, 'SITE_WITHOUT_PRODUCTION']);
    const refusedBeat = await as(plOperator).post(
      `/api/admin/station-sessions/${plHeld.session.id}/heartbeat`,
    );
    expect([refusedBeat.status, refusedBeat.body.code]).toEqual([409, 'SITE_WITHOUT_PRODUCTION']);
    const refusedOpen = await open(plOperator, foreign.qrUrl);
    expect([refusedOpen.status, refusedOpen.body.code]).toEqual([409, 'SITE_WITHOUT_PRODUCTION']);
    const refusedTakeover = await as(plOperator).post(
      `/api/admin/station-sessions/${plHeld.session.id}/takeover`,
      { requestId: randomUUID(), reason: 'test převzetí' },
    );
    expect(refusedTakeover.status).toBe(409);
    await release(plOperator, plHeld.session.id).expect(200);
  });

  it('replays open, takeover and release by request id: one change, one event', async () => {
    const ws = await station();
    const openId = randomUUID();
    const first = (await open(operator, ws.qrUrl, openId).expect(201)).body as StationSessionResult;
    const replay = (await open(operator, ws.qrUrl, openId).expect(201))
      .body as StationSessionResult;
    expect(replay).toEqual(first);

    const takeoverId = randomUUID();
    const body = { requestId: takeoverId, reason: 'převzetí s výpadkem odpovědi' };
    const path = `/api/admin/station-sessions/${first.session.id}/takeover`;
    const taken = (await as(supervisor).post(path, body).expect(201)).body as StationSessionResult;
    // The response was "lost": the same attempt again returns the stored result, not SESSION_ENDED.
    const retried = (await as(supervisor).post(path, body).expect(201))
      .body as StationSessionResult;
    expect(retried).toEqual(taken);
    expect(
      await t.prisma.workstationSessionEvent.count({
        where: { sessionId: first.session.id, type: 'TAKEN_OVER' },
      }),
    ).toBe(1);
    expect(
      await t.prisma.workstationSession.count({
        where: { workstation: { code: ws.code }, status: 'ACTIVE' },
      }),
    ).toBe(1);

    const releaseId = randomUUID();
    const rel = (id: string) =>
      as(supervisor).post(`/api/admin/station-sessions/${taken.session.id}/release`, {
        requestId: id,
      });
    await rel(releaseId).expect(200);
    await rel(releaseId).expect(200);
    expect(
      await t.prisma.workstationSessionEvent.count({
        where: { sessionId: taken.session.id, type: 'RELEASED' },
      }),
    ).toBe(1);
  });

  it('enforces the session and station invariants in the database', async () => {
    const ws = await station();
    const row = await t.prisma.workstation.findUniqueOrThrow({ where: { code: ws.code } });
    // A status change without its event fails at commit.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "workstations" SET "status" = 'INACTIVE' WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRaw`UPDATE "workstations" SET "name" = 'jiný' WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`DELETE FROM "workstation_events" WHERE "workstation_id" = ${row.id}::uuid`,
    ).rejects.toThrow();

    const held = (await open(operator, ws.qrUrl).expect(201)).body as StationSessionResult;
    const userId = (
      await t.prisma.workstationSession.findUniqueOrThrow({ where: { id: held.session.id } })
    ).userId;
    // A second ACTIVE session of the station or the user is impossible.
    await expect(
      t.prisma.$transaction(async (tx) => {
        const s = await tx.workstationSession.create({
          data: {
            workstationId: row.id,
            userId: adminId,
            siteId: row.siteId,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        await tx.workstationSessionEvent.create({
          data: {
            sessionId: s.id,
            type: 'OPENED',
            actorId: adminId,
            operationRequestId: randomUUID(),
          },
        });
      }),
    ).rejects.toThrow();
    await release(operator, held.session.id).expect(200);
    // An ended session never changes again.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "workstation_sessions" SET "lease_expires_at" = now() WHERE "id" = ${held.session.id}::uuid`,
    ).rejects.toThrow();
    expect(userId).toBeTruthy();
  });
});
