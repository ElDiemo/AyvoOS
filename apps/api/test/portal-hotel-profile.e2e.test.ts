import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HotelDetail, PortalHotelProfile } from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HotelsService } from '../src/customers/hotels.service.js';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { crateFactory, createHotel, createOrder } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const portalToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
const otp = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
const client = (over: Partial<{ origin: string; secFetchSite: string | null }> = {}) => ({
  ip: `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`,
  origin: PORTAL_ORIGIN,
  secFetchSite: 'same-origin',
  ...over,
});

/** A complete, valid profile (what the portal form sends). */
const profileOf = (over: Record<string, unknown> = {}) => ({
  addressLine1: 'Nová 12',
  addressLine2: '2. patro',
  postalCode: '750 02',
  city: 'Přerov',
  contactName: 'Jana Nová',
  contactPhone: '+420 600 100 200',
  contactEmail: 'jana.nova@hotel.test',
  receivingContactName: 'Petr Sklad',
  receivingContactPhone: '+420 600 300 400',
  receivingContactEmail: '',
  deliveryNote: 'Příjem zboží 7–11 h, rampa ze dvora.',
  ...over,
});

/**
 * "Profil hotelu" through the core's portal contract and the real database: a hotel account reads
 * and edits only its granted hotels' whitelisted fields; the browser request is checked again
 * (CSRF); the session and the grant on that hotel are checked again inside the write's transaction,
 * under the account's lock, so a revocation that commits first is seen and the save is refused;
 * concurrent edits never overwrite each other (PROFILE_STALE); existing orders keep their snapshot.
 * Synthetic accounts and hotels only.
 */
describe.skipIf(!hasDatabase)('hotel portal: the hotel profile', () => {
  let t: TestApp;
  let su: TestApp;
  let adminId: string;
  let hotelA: HotelDetail;
  let hotelB: HotelDetail;

  const core = () => request(t.app.getHttpServer());
  const get = (path: string, session?: string, token = portalToken) => {
    const r = core().get(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const post = (path: string, session?: string, token = portalToken) => {
    const r = core()
      .post(`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const read = async (session: string, hotelId: string) => {
    const res = await get(`hotels/${hotelId}/profile`, session);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as PortalHotelProfile;
  };
  const save = (
    session: string,
    hotelId: string,
    expected: string,
    profile: Record<string, unknown>,
    c = client(),
    reason = 'Nová recepce a příjem zboží ze dvora',
  ) => post(`hotels/${hotelId}/profile`, session).send({ expected, profile, reason, client: c });
  const row = (id: string) => t.prisma.hotel.findUniqueOrThrow({ where: { id } });
  const audits = (code: string) =>
    t.prisma.auditEvent.findMany({
      where: { type: 'HOTEL_UPDATED', payload: { path: ['hotel'], equals: code } },
      orderBy: { occurredAt: 'asc' },
    });
  const grant = (userId: string, hotelIds: string[]) =>
    t.app.get(PortalGrantsService).issue(adminId, {
      requestId: randomUUID(),
      userId,
      payerCustomerId: randomUUID(),
      hotelIds,
      reason: 'synthetic portal grant',
      financeCheck: { payerVersion: 1, hotelIds, checkedAt: new Date().toISOString() },
    });
  const revoke = (grantId: string) =>
    t.app.get(PortalGrantsService).revoke(adminId, grantId, 'synthetic revocation');

  /** An invited and activated PORTAL account with a portal session. */
  async function account() {
    const user = await t.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal user', audience: 'PORTAL' },
    });
    await t.app
      .get(InvitationsService)
      .send(null, user.id, randomUUID(), 'synthetic portal invitation', 'PORTAL');
    const tokens = t.app.get(NativeTokensService);
    await tokens.deliverPending();
    const mail = tokens.deliveriesForTest().findLast((m) => m.to === user.email)!;
    const step = await post('auth/activate').send({
      token: tokenOf(mail.url),
      password: PASSWORD,
      client: client(),
    });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    const done = await post('auth/mfa').send({
      challenge: step.body.challenge,
      code: otp(step.body.setupKey),
      client: client(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { user, session: done.body.session as string };
  }

  /** Waits until `n` backends of this database wait for a lock. */
  async function lockWaiter(n = 1) {
    for (let i = 0; i < 200; i++) {
      const [r] = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (r!.n >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no lock waiter');
  }

  beforeAll(async () => {
    t = await createTestApp(
      {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
        PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
        FINANCE_SERVICE_TOKEN_SHA256: sha(financeToken),
        PORTAL_DB_ACQUIRE_TIMEOUT_MS: '1500',
        PORTAL_DB_STATEMENT_TIMEOUT_MS: '5000',
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    su = await createTestApp();
    adminId = (
      await t.prisma.user.create({ data: { email: unique('grant-admin'), displayName: 'Admin' } })
    ).id;
    hotelA = await createHotel(su, { name: 'Hotel Profil A' });
    hotelB = await createHotel(su, { name: 'Hotel Profil B' });
  });
  afterAll(async () => {
    await t?.close();
    await su?.close();
  });

  it('reads only a granted hotel’s profile; a foreign or unknown id is “not found”', async () => {
    const a = await account();
    await grant(a.user.id, [hotelA.id]);
    const profile = await read(a.session, hotelA.id);
    expect(profile).toMatchObject({
      id: hotelA.id,
      name: 'Hotel Profil A',
      countryCode: hotelA.countryCode,
      address: { addressLine1: hotelA.address.addressLine1, city: hotelA.address.city },
      contact: { name: hotelA.contact.name, email: hotelA.contact.email },
      receiving: { contactName: null, deliveryNote: null },
    });
    expect(profile.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Nothing internal: no code, serving site, creator or grant.
    expect(Object.keys(profile).sort()).toEqual(
      ['address', 'contact', 'countryCode', 'fingerprint', 'id', 'name', 'receiving'].sort(),
    );
    for (const id of [hotelB.id, randomUUID()]) {
      const res = await get(`hotels/${id}/profile`, a.session);
      expect([res.status, res.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    }
    expect((await get(`hotels/${hotelA.id}/profile`)).status).toBe(401);
    expect((await get(`hotels/${hotelA.id}/profile`, 'no-such-session')).status).toBe(401);
    expect((await get(`hotels/${hotelA.id}/profile`, a.session, financeToken)).status).toBe(401);
  });

  it('saves the whitelisted fields, audited; the name, country, code and site never change', async () => {
    const a = await account();
    const g = await grant(a.user.id, [hotelA.id]);
    const before = await row(hotelA.id);
    const auditsBefore = (await audits(hotelA.code)).length;
    const current = await read(a.session, hotelA.id);
    const res = await save(a.session, hotelA.id, current.fingerprint, profileOf());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Hotel Profil A',
      address: { addressLine1: 'Nová 12', addressLine2: '2. patro', city: 'Přerov' },
      contact: { name: 'Jana Nová', phone: '+420 600 100 200' },
      receiving: {
        contactName: 'Petr Sklad',
        contactEmail: null,
        deliveryNote: 'Příjem zboží 7–11 h, rampa ze dvora.',
      },
    });
    expect(res.body.fingerprint).not.toBe(current.fingerprint);
    const after = await row(hotelA.id);
    expect(after).toMatchObject({
      name: before.name,
      countryCode: before.countryCode,
      code: before.code,
      serial: before.serial,
      fulfillmentSiteId: before.fulfillmentSiteId,
      createdBy: before.createdBy,
      addressLine1: 'Nová 12',
      receivingContactEmail: null,
    });
    const events = await audits(hotelA.code);
    expect(events).toHaveLength(auditsBefore + 1);
    const event = events.at(-1)!;
    expect(event).toMatchObject({
      actorUserId: a.user.id,
      siteId: before.fulfillmentSiteId,
      reason: 'Nová recepce a příjem zboží ze dvora',
    });
    expect(event.payload).toMatchObject({
      hotel: hotelA.code,
      via: 'PORTAL',
      grantId: g.id,
      before: { addressLine1: before.addressLine1, deliveryNote: null },
      after: { addressLine1: 'Nová 12', deliveryNote: 'Příjem zboží 7–11 h, rampa ze dvora.' },
    });
    // A repeated save of the same values (e.g. a double click) changes and audits nothing.
    const again = await save(a.session, hotelA.id, current.fingerprint, profileOf());
    expect(again.status).toBe(200);
    expect(again.body.fingerprint).toBe(res.body.fingerprint);
    expect(await audits(hotelA.code)).toHaveLength(auditsBefore + 1);
    // The staff detail shows the same values (one source of truth).
    const staff = await request(su.app.getHttpServer())
      .get(`/api/admin/hotels/${hotelA.code}`)
      .expect(200);
    expect(staff.body.address.addressLine1).toBe('Nová 12');
    expect(staff.body.practical.receivingContact.name).toBe('Petr Sklad');
  });

  it('refuses any other field, invalid values and a cross-site request — nothing changes', async () => {
    const a = await account();
    await grant(a.user.id, [hotelA.id]);
    const current = await read(a.session, hotelA.id);
    const stored = await row(hotelA.id);
    for (const over of [
      { name: 'Jiný název' },
      { countryCode: 'SK' },
      { fulfillmentSiteId: randomUUID() },
      { code: 'HT-999999' },
      { contactEmail: 'not-an-e-mail' },
      { contactPhone: 'abc' },
      { addressLine1: '' },
      { deliveryNote: 'x'.repeat(501) },
      { receivingContactName: '', receivingContactPhone: '+420 600 000 000' },
    ]) {
      const res = await save(a.session, hotelA.id, current.fingerprint, profileOf(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    const extra = await post(`hotels/${hotelA.id}/profile`, a.session).send({
      expected: current.fingerprint,
      profile: profileOf({ city: 'Brno' }),
      reason: 'Přestěhování recepce',
      client: client(),
      hotelId: hotelB.id,
    });
    expect(extra.status).toBe(400);
    // The reason is required (owner 2026-11-09).
    for (const reason of [undefined, '', '  ', 'x'.repeat(501)]) {
      const res = await post(`hotels/${hotelA.id}/profile`, a.session).send({
        expected: current.fingerprint,
        profile: profileOf({ city: 'Brno' }),
        ...(reason === undefined ? {} : { reason }),
        client: client(),
      });
      expect(res.status, JSON.stringify(reason)).toBe(400);
    }
    for (const c of [
      client({ origin: 'https://evil.example' }),
      client({ origin: 'https://dev.ayvo.co' }),
      client({ secFetchSite: 'cross-site' }),
      client({ secFetchSite: 'same-site' }),
    ]) {
      const res = await save(
        a.session,
        hotelA.id,
        current.fingerprint,
        profileOf({ city: 'Brno' }),
        c,
      );
      expect([res.status, res.body.code], JSON.stringify(c)).toEqual([403, 'CSRF_REJECTED']);
    }
    expect(
      (
        await post(`hotels/${hotelA.id}/profile`, a.session, financeToken).send({
          expected: current.fingerprint,
          profile: profileOf({ city: 'Brno' }),
          client: client(),
        })
      ).status,
    ).toBe(401);
    expect(await row(hotelA.id)).toEqual(stored);
  });

  it('two hotel accounts: each edits only its own hotel; a stale save never overwrites', async () => {
    const a = await account();
    const b = await account();
    const c = await account();
    await grant(a.user.id, [hotelA.id]);
    await grant(b.user.id, [hotelB.id]);
    await grant(c.user.id, [hotelA.id]);
    const ofA = await read(a.session, hotelA.id);
    // B never reaches A's hotel, neither reading nor writing.
    expect((await get(`hotels/${hotelA.id}/profile`, b.session)).status).toBe(404);
    const foreign = await save(b.session, hotelA.id, ofA.fingerprint, profileOf({ city: 'Cizí' }));
    expect([foreign.status, foreign.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    expect((await row(hotelA.id)).city).not.toBe('Cizí');
    // A and C share hotel A: A saves first; C's save from the older values is refused.
    const ofC = await read(c.session, hotelA.id);
    expect(ofC.fingerprint).toBe(ofA.fingerprint);
    expect(
      (await save(a.session, hotelA.id, ofA.fingerprint, profileOf({ city: 'Olomouc' }))).status,
    ).toBe(200);
    const stale = await save(c.session, hotelA.id, ofC.fingerprint, profileOf({ city: 'Zlín' }));
    expect([stale.status, stale.body.code]).toEqual([409, 'PROFILE_STALE']);
    expect((await row(hotelA.id)).city).toBe('Olomouc');
    // After reloading, C's change goes through.
    const fresh = await read(c.session, hotelA.id);
    expect(
      (await save(c.session, hotelA.id, fresh.fingerprint, profileOf({ city: 'Zlín' }))).status,
    ).toBe(200);
    // B edits its own hotel.
    const ofB = await read(b.session, hotelB.id);
    expect(
      (await save(b.session, hotelB.id, ofB.fingerprint, profileOf({ city: 'Prostějov' }))).status,
    ).toBe(200);
    expect((await row(hotelB.id)).city).toBe('Prostějov');
  });

  it('a revoked grant: that hotel is “not found”; the last grant ends the session', async () => {
    const a = await account();
    const gA = await grant(a.user.id, [hotelA.id]);
    const gB = await grant(a.user.id, [hotelB.id]);
    const ofB = await read(a.session, hotelB.id);
    await revoke(gB.id);
    const res = await save(a.session, hotelB.id, ofB.fingerprint, profileOf({ city: 'Odvoláno' }));
    expect([res.status, res.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    expect((await get(`hotels/${hotelB.id}/profile`, a.session)).status).toBe(404);
    expect((await row(hotelB.id)).city).not.toBe('Odvoláno');
    const ofA = await read(a.session, hotelA.id);
    await revoke(gA.id);
    const ended = await save(a.session, hotelA.id, ofA.fingerprint, profileOf({ city: 'Konec' }));
    expect(ended.status).toBe(401);
    expect((await row(hotelA.id)).city).not.toBe('Konec');
  });

  it('a revocation committing while the save waits for the account’s lock refuses the save', async () => {
    const a = await account();
    const g = await grant(a.user.id, [hotelA.id]);
    await grant(a.user.id, [hotelB.id]); // the session survives; only hotel A is lost
    const current = await read(a.session, hotelA.id);
    const stored = await row(hotelA.id);
    // A revocation in progress: it holds the account's row lock, as PortalGrantsService does.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const revocation = withPrivileged((db) =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${a.user.id}::uuid FOR UPDATE`;
          await tx.portalGrant.update({
            where: { id: g.id },
            data: { revokedAt: new Date(), revokedBy: adminId, revokeReason: 'synthetic' },
          });
          locked();
          await held;
        },
        { timeout: 30_000 },
      ),
    );
    await isLocked;
    const saving = save(a.session, hotelA.id, current.fingerprint, profileOf({ city: 'Souběh' }));
    const pending = saving.then((r) => r); // start the request now
    await lockWaiter();
    release();
    await revocation;
    const res = await pending;
    expect([res.status, res.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    expect(await row(hotelA.id)).toEqual(stored);
  });

  it('a staff edit waiting behind a portal save audits what it replaced (B → C, not A → C)', async () => {
    // Review 5829367477: the staff path read the row before its FOR UPDATE and audited that copy.
    const hotel = await createHotel(su, { name: 'Hotel Profil Souběh' });
    const a = await account();
    await grant(a.user.id, [hotel.id]);
    const current = await read(a.session, hotel.id); // state A: no receiving contact
    // Something holds the hotel's row lock, so both writers queue behind it in a known order.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = withPrivileged((db) =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "hotels" WHERE "id" = ${hotel.id}::uuid FOR UPDATE`;
          locked();
          await held;
        },
        { timeout: 30_000 },
      ),
    );
    await isLocked;
    // First in the queue: the portal saves B. Second: the staff edit saves C.
    const portal = save(
      a.session,
      hotel.id,
      current.fingerprint,
      profileOf({ receivingContactName: 'Portál B', deliveryNote: 'Poznámka B' }),
    ).then((r) => r);
    await lockWaiter(1);
    const staff = t.app.get(HotelsService).updatePractical(adminId, hotel.code, {
      requestId: randomUUID(),
      deliveryNote: 'Poznámka C',
      receivingContactName: 'Sklad C',
      receivingContactPhone: null,
      receivingContactEmail: null,
      reason: 'interní úprava (souběh)',
    });
    await lockWaiter(2);
    release();
    await holder;
    const res = await portal;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await staff;

    const stored = await row(hotel.id);
    expect([stored.receivingContactName, stored.deliveryNote]).toEqual(['Sklad C', 'Poznámka C']);
    type Change = { via?: string; before: Record<string, unknown>; after: Record<string, unknown> };
    const trail = (await audits(hotel.code)).map((e) => e.payload as unknown as Change);
    expect(trail.map((p) => p.via ?? 'STAFF')).toEqual(['PORTAL', 'STAFF']);
    const [b, c] = trail as [Change, Change];
    expect(b.after).toMatchObject({ receivingContactName: 'Portál B', deliveryNote: 'Poznámka B' });
    // The staff change is recorded as replacing B — the chain A → B → C can be followed.
    expect(c.before).toMatchObject({
      receivingContactName: 'Portál B',
      deliveryNote: 'Poznámka B',
    });
    expect(c.after).toMatchObject({ receivingContactName: 'Sklad C', deliveryNote: 'Poznámka C' });
  });

  it('existing orders keep their address snapshot; a new order takes the new address', async () => {
    const kit = (await crateFactory(su)).kit;
    const hotel = await createHotel(su, { name: 'Hotel Profil Snapshot' });
    const old = await createOrder(su, hotel.code, [{ productCode: kit.productCode, crates: 1 }]);
    const snapshot = await t.prisma.order.findUniqueOrThrow({ where: { code: old.code } });
    const a = await account();
    await grant(a.user.id, [hotel.id]);
    const current = await read(a.session, hotel.id);
    const res = await save(
      a.session,
      hotel.id,
      current.fingerprint,
      profileOf({ addressLine1: 'Snapshotová 99', contactName: 'Nový Kontakt' }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await t.prisma.order.findUniqueOrThrow({ where: { code: old.code } })).toEqual(snapshot);
    expect(snapshot.addressLine1).toBe(hotel.address.addressLine1);
    const next = await createOrder(su, hotel.code, [{ productCode: kit.productCode, crates: 1 }]);
    const fresh = await t.prisma.order.findUniqueOrThrow({ where: { code: next.code } });
    expect([fresh.addressLine1, fresh.contactName, fresh.hotelName]).toEqual([
      'Snapshotová 99',
      'Nový Kontakt',
      'Hotel Profil Snapshot',
    ]);
  });
});
