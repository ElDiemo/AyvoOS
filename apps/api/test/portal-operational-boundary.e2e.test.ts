import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { HotelDetail, PortalHotelProfile } from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { isOperational, pragueToday } from '../src/portal-grants/portal-fences.service.js';
import { createHotel } from './support/order-fixtures.js';
import { invoicesCheck, operationsCheck } from './support/portal-check.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const portalToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const linkToken = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
const otp = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
const client = () => ({
  ip: `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`,
  origin: PORTAL_ORIGIN,
  secFetchSite: 'same-origin',
});
/** A complete, valid profile (what the portal form sends), a new delivery note each time. */
const profileOf = () => ({
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
  deliveryNote: `Příjem zboží 7–11 h (${randomUUID().slice(0, 6)})`,
});
/** `YYYY-MM-DD`, `n` days from today in Prague. */
const fromToday = (n: number) => {
  const d = new Date(`${pragueToday()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The operational boundary of the hotel portal (v6, #148 comments 6773883145 and 6773928715,
 * approved in review 5846139485), the core's side, real database: a grant's hotel opens either the
 * payer's invoices only or also its operations (detail, profile read and save), as Finance checked
 * it. A fence Finance writes before a change of payer ends the payer's operations on that hotel
 * from the day after its last day; only a resolution by a committed explicit restore AND a new
 * check after it bring them back. Invoices (Finance's introspection) always keep every hotel of
 * the grant. Finance's own side — reserving revisions, writing the fence before its terms, the
 * restore — is the next step; here the core's contract is called as Finance will call it.
 * Synthetic accounts, payers and hotels only.
 */
describe.skipIf(!hasDatabase)('hotel portal: the operational boundary (core)', () => {
  let t: TestApp;
  /** Finance's caller: the same database, the staff sign-in (the admin's forwarded session). */
  let fa: TestApp;
  let su: TestApp;
  let admin: string;
  let adminId: string;
  let h: HotelDetail;
  let h2: HotelDetail;

  const core = () => request(t.app.getHttpServer());
  const portal = (method: 'get' | 'post', path: string, session: string) =>
    core()
      [method](`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${portalToken}`)
      .set('x-ayvo-portal-session', session);
  /** Finance's call: its token and the forwarded staff session. */
  const finance = (path: string) =>
    request(fa.app.getHttpServer())
      .post(`/api/internal/v1/finance/${path}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .set('x-ayvo-session', admin.replace(/^ayvo_session=/, ''));
  const introspect = (session: string) =>
    core()
      .post('/api/internal/v1/finance/introspect-portal')
      .set('Authorization', `Bearer ${financeToken}`)
      .set('x-ayvo-portal-session', session);

  const fence = (
    payer: string,
    hotelId: string,
    endsOn: string,
    termsRevision: number,
    requestId: string = randomUUID(),
  ) =>
    finance('portal-fences').send({
      requestId,
      payerCustomerId: payer,
      hotelId,
      endsOn,
      termsRevision,
      reason: 'Převod hotelu (syntetický)',
    });
  const restore = (body: Record<string, unknown>) =>
    finance('portal-fence-resolutions').send({ kind: 'RESTORE', ...body });
  const grant = (
    userId: string,
    payer: string,
    hotelIds: string[],
    financeCheck: {
      payerVersion: number;
      hotels: (
        | ReturnType<typeof operationsCheck>['hotels'][number]
        | ReturnType<typeof invoicesCheck>['hotels'][number]
      )[];
      checkedAt: string;
    },
  ) =>
    finance('portal-grants').send({
      requestId: randomUUID(),
      userId,
      payerCustomerId: payer,
      hotelIds,
      reason: 'synthetic portal grant',
      financeCheck,
    });
  const replace = (
    grantId: string,
    payer: string,
    hotelIds: string[],
    financeCheck: ReturnType<typeof operationsCheck>,
  ) =>
    finance(`portal-grants/${grantId}/replace`).send({
      requestId: randomUUID(),
      payerCustomerId: payer,
      hotelIds,
      reason: 'new check in Finance',
      financeCheck,
    });

  /** An activated PORTAL account with a portal session (the real sign-in path). */
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
    const step = await core()
      .post('/api/internal/v1/portal/auth/activate')
      .set('Authorization', `Bearer ${portalToken}`)
      .send({ token: linkToken(mail.url), password: PASSWORD, client: client() });
    expect(step.status, JSON.stringify(step.body)).toBe(200);
    const done = await core()
      .post('/api/internal/v1/portal/auth/mfa')
      .set('Authorization', `Bearer ${portalToken}`)
      .send({ challenge: step.body.challenge, code: otp(step.body.setupKey), client: client() });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { userId: user.id, session: done.body.session as string };
  }

  /** What the session reaches on a hotel: detail, profile read and save (200 or 404 each). */
  async function reach(session: string, hotelId: string) {
    const detail = (await portal('get', `hotels/${hotelId}`, session)).status;
    const profile = await portal('get', `hotels/${hotelId}/profile`, session);
    const expected =
      profile.status === 200 ? (profile.body as PortalHotelProfile).fingerprint : '0'.repeat(64);
    const save = await portal('post', `hotels/${hotelId}/profile`, session).send({
      expected,
      profile: profileOf(),
      reason: 'Kontrola hranice (syntetická)',
      client: client(),
    });
    expect([200, 404], JSON.stringify(save.body)).toContain(save.status);
    return { detail, profile: profile.status, save: save.status };
  }
  const invoiceHotels = async (session: string) =>
    ((await introspect(session).expect(200)).body.grants as { hotelIds: string[] }[]).flatMap(
      (g) => g.hotelIds,
    );

  beforeAll(async () => {
    t = await createTestApp(
      {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
        PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
        FINANCE_SERVICE_TOKEN_SHA256: sha(financeToken),
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    fa = await createTestApp(
      { FINANCE_SERVICE_TOKEN_SHA256: sha(financeToken) },
      {},
      { auth: 'real' },
    );
    su = await createTestApp();
    const a = await prepareInvitedUser(fa, { email: unique('fence-admin'), displayName: 'Admin' });
    adminId = a.id;
    await fa.prisma.userRole.create({
      data: { userId: a.id, roleCode: 'ADMIN', grantReason: 'operational boundary test' },
    });
    admin = await sessionCookie(fa, a.email);
    h = await createHotel(su, { name: 'Hotel Hranice' });
    h2 = await createHotel(su, { name: 'Hotel Hranice 2' });
  });
  afterAll(async () => {
    if (adminId)
      await t.prisma.userRole.updateMany({
        where: { userId: adminId, roleCode: 'ADMIN', revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'end of test' },
      });
    await t?.close();
    await fa?.close();
    await su?.close();
  });

  it('the migration: the access column has no default, OPERATIONS needs its revision (DB)', async () => {
    const [col] = await t.prisma.$queryRaw<{ default: string | null; nullable: string }[]>`
      SELECT column_default AS "default", is_nullable AS "nullable" FROM information_schema.columns
      WHERE table_name = 'portal_grant_hotels' AND column_name = 'access'`;
    expect(col).toEqual({ default: null, nullable: 'NO' });
    const [check] = await t.prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'portal_grant_hotels_access_check'`;
    expect(check!.def).toContain('INVOICES');
    expect(check!.def).toContain('checked_revision IS NOT NULL');
  });

  it('invoices only: the hotel is in the invoices, never in detail, profile or its save; an agreement hotel of the same grant is', async () => {
    const a = await account();
    const payer = randomUUID();
    const check = {
      ...operationsCheck([h2.id]),
      hotels: [...operationsCheck([h2.id]).hotels, ...invoicesCheck([h.id]).hotels],
    };
    const g = await grant(a.userId, payer, [h.id, h2.id], check);
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(await reach(a.session, h.id)).toEqual({ detail: 404, profile: 404, save: 404 });
    expect(await reach(a.session, h2.id)).toEqual({ detail: 200, profile: 200, save: 200 });
    expect((await invoiceHotels(a.session)).sort()).toEqual([h.id, h2.id].sort());
    expect(
      ((await portal('get', 'hotels', a.session).expect(200)).body as { id: string }[]).map(
        (x) => x.id,
      ),
    ).toEqual([h2.id]);
  });

  it('an immediate change of payer: the fence ends A’s operations on H at once; A’s other hotel and invoices stay; B has H', async () => {
    const a = await account();
    const b = await account();
    const [payerA, payerB] = [randomUUID(), randomUUID()];
    expect(
      (await grant(a.userId, payerA, [h.id, h2.id], operationsCheck([h.id, h2.id]))).status,
    ).toBe(201);
    expect((await reach(a.session, h.id)).detail).toBe(200);
    // Finance writes the fence first (last day yesterday), then commits the terms naming B (r2).
    expect((await fence(payerA, h.id, fromToday(-1), 2)).status).toBe(200);
    expect(
      (await grant(b.userId, payerB, [h.id], operationsCheck([h.id], { revision: 2 }))).status,
    ).toBe(201);
    expect(await reach(a.session, h.id)).toEqual({ detail: 404, profile: 404, save: 404 });
    expect((await reach(a.session, h2.id)).detail).toBe(200);
    expect((await invoiceHotels(a.session)).sort()).toEqual([h.id, h2.id].sort());
    expect(await reach(b.session, h.id)).toEqual({ detail: 200, profile: 200, save: 200 });
  });

  it('a future change of payer: A keeps operations up to the fence’s last day and has none from the next day', async () => {
    const a = await account();
    const payer = randomUUID();
    expect((await grant(a.userId, payer, [h2.id], operationsCheck([h2.id]))).status).toBe(201);
    const endsOn = fromToday(3);
    expect((await fence(payer, h2.id, endsOn, 2)).status).toBe(200);
    expect((await reach(a.session, h2.id)).detail).toBe(200);
    // The read rule on the clock (one condition per fence), as the core evaluates it every day.
    const stored = await t.prisma.portalGrantHotel.findFirstOrThrow({
      where: { hotelId: h2.id, grant: { userId: a.userId } },
    });
    const fences = await t.prisma.portalOperationalFence.findMany({
      where: { payerCustomerId: payer, hotelId: h2.id },
      include: { resolution: true },
    });
    expect(isOperational(stored, fences, endsOn)).toBe(true);
    expect(isOperational(stored, fences, fromToday(4))).toBe(false);
    // Finance's own end of the window (operationsUntil) counts the same way.
    const own = { ...stored, operationsUntil: new Date(`${endsOn}T00:00:00.000Z`) };
    expect(isOperational(own, [], endsOn)).toBe(true);
    expect(isOperational(own, [], fromToday(4))).toBe(false);
  });

  it('a lost answer: the same fence request again gets the same fence, one row; another meaning under it is refused', async () => {
    const payer = randomUUID();
    const id = randomUUID();
    const first = await fence(payer, h.id, fromToday(-1), 3, id);
    // Finance retries (its answer was lost, or it had not stored the fence id yet).
    const again = await fence(payer, h.id, fromToday(-1), 3, id);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
    expect(await t.prisma.portalOperationalFence.count({ where: { requestId: id } })).toBe(1);
    const other = await fence(payer, h.id, fromToday(5), 3, id);
    expect([other.status, other.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
  });

  it('a stale check: OPERATIONS checked before the pair’s newest fence is STALE_TERMS; the same revision as a scheduled transfer passes and ends at the fence', async () => {
    const a = await account();
    const payer = randomUUID();
    expect((await fence(payer, h2.id, fromToday(10), 4)).status).toBe(200);
    const stale = await grant(a.userId, payer, [h2.id], operationsCheck([h2.id], { revision: 3 }));
    expect([stale.status, stale.body.code, stale.body.details]).toEqual([
      409,
      'STALE_TERMS',
      { hotelIds: [h2.id] },
    ]);
    // The same revision as the transfer (v4 "≥"): operations until the fence's last day only.
    const fresh = await grant(a.userId, payer, [h2.id], operationsCheck([h2.id], { revision: 4 }));
    expect(fresh.status).toBe(201);
    expect((await reach(a.session, h2.id)).detail).toBe(200);
    // Invoices only never meets STALE_TERMS (no operations to protect).
    const b = await account();
    expect((await grant(b.userId, payer, [h2.id], invoicesCheck([h2.id]))).status).toBe(201);
  });

  it('only an explicit restore of THIS fence and a new check after it bring operations back; replay writes one resolution', async () => {
    const a = await account();
    const [payer, foreignPayer] = [randomUUID(), randomUUID()];
    const g = await grant(a.userId, payer, [h.id], operationsCheck([h.id]));
    expect(g.status).toBe(201);
    // r2: an immediate transfer whose Finance side never finished — the fence stays.
    const f2 = (await fence(payer, h.id, fromToday(-1), 2)).body as { id: string };
    const foreign = (await fence(foreignPayer, h.id, fromToday(-1), 2)).body as { id: string };
    expect((await reach(a.session, h.id)).detail).toBe(404);

    // The evidence is typed: another kind or an unknown field is refused (400), nothing written.
    const evidence = {
      restoreRequestId: randomUUID(),
      payerCustomerId: payer,
      hotelId: h.id,
      restoreRevision: 5,
      fenceIds: [f2.id],
    };
    expect((await restore({ ...evidence, kind: 'CHANGE' })).status).toBe(400);
    expect((await restore({ ...evidence, priceRevision: 4 })).status).toBe(400);
    // Another pair's fence, or a revision not after the fence's: 409, nothing written.
    const notOurs = await restore({ ...evidence, fenceIds: [f2.id, foreign.id] });
    expect([notOurs.status, notOurs.body.code]).toEqual([409, 'FENCE_NOT_OF_PAIR']);
    const notLater = await restore({ ...evidence, restoreRevision: 2 });
    expect([notLater.status, notLater.body.code]).toEqual([409, 'RESTORE_NOT_LATER']);
    expect(
      await t.prisma.portalOperationalFenceResolution.count({ where: { fenceId: f2.id } }),
    ).toBe(0);

    // A higher revision of something else (e.g. a price change r4) is not a restore: a fresh check
    // with it still gets no operations while F2 is unresolved.
    const priced = await replace(
      g.body.id,
      payer,
      [h.id],
      operationsCheck([h.id], { revision: 4 }),
    );
    expect(priced.status).toBe(201);
    expect((await reach(a.session, h.id)).detail).toBe(404);

    // The committed restore r5 resolves F2; the grant checked BEFORE it (r4) still has none.
    const done = await restore(evidence);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await reach(a.session, h.id)).detail).toBe(404);
    // Its replay (a lost answer): the same result, one resolution.
    expect((await restore(evidence)).body).toEqual(done.body);
    expect(
      await t.prisma.portalOperationalFenceResolution.count({ where: { fenceId: f2.id } }),
    ).toBe(1);
    // Another restore naming the resolved fence: refused.
    const twice = await restore({
      ...evidence,
      restoreRequestId: randomUUID(),
      restoreRevision: 6,
    });
    expect([twice.status, twice.body.code]).toEqual([409, 'FENCE_ALREADY_RESOLVED']);

    // A new check after the restore (r5): operations again.
    const rechecked = await replace(
      priced.body.id,
      payer,
      [h.id],
      operationsCheck([h.id], { revision: 5 }),
    );
    expect(rechecked.status).toBe(201);
    expect(await reach(a.session, h.id)).toEqual({ detail: 200, profile: 200, save: 200 });

    // A later fence of the same pair (A → C, r7) needs its own restore: one condition per fence.
    expect((await fence(payer, h.id, fromToday(-1), 7)).status).toBe(200);
    expect((await reach(a.session, h.id)).detail).toBe(404);
    expect(await invoiceHotels(a.session)).toContain(h.id);
  });

  it('fences and resolutions are history: never changed or deleted (DB)', async () => {
    const payer = randomUUID();
    const f = (await fence(payer, h2.id, fromToday(-1), 1)).body as { id: string };
    await expect(
      t.prisma
        .$executeRaw`UPDATE "portal_operational_fences" SET "ends_on" = now()::date + 30 WHERE "id" = ${f.id}::uuid`,
    ).rejects.toThrow(/history/);
    await expect(
      t.prisma.$executeRaw`DELETE FROM "portal_operational_fences" WHERE "id" = ${f.id}::uuid`,
    ).rejects.toThrow(/history/);
    await restore({
      restoreRequestId: randomUUID(),
      payerCustomerId: payer,
      hotelId: h2.id,
      restoreRevision: 2,
      fenceIds: [f.id],
    }).expect(200);
    await expect(
      t.prisma
        .$executeRaw`DELETE FROM "portal_operational_fence_resolutions" WHERE "fence_id" = ${f.id}::uuid`,
    ).rejects.toThrow(/history/);
    // A direct write cannot resolve with an earlier revision either.
    const g = (await fence(payer, h2.id, fromToday(-1), 9)).body as { id: string };
    await expect(
      t.prisma
        .$executeRaw`INSERT INTO "portal_operational_fence_resolutions" ("fence_id", "restore_revision", "restore_request_id") VALUES (${g.id}::uuid, 9, ${randomUUID()}::uuid)`,
    ).rejects.toThrow(/later restore revision/);
  });

  it('the contract: Finance’s token and billing_manage; another caller is refused', async () => {
    const body = {
      requestId: randomUUID(),
      payerCustomerId: randomUUID(),
      hotelId: h.id,
      endsOn: fromToday(1),
      termsRevision: 1,
      reason: 'x',
    };
    // No Finance token: the global guard refuses before the route.
    expect(
      (
        await request(fa.app.getHttpServer())
          .post('/api/internal/v1/finance/portal-fences')
          .send(body)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(fa.app.getHttpServer())
          .post('/api/internal/v1/finance/portal-fences')
          .set('Authorization', `Bearer ${portalToken}`)
          .send(body)
      ).status,
    ).toBe(401);
    // An unknown hotel: 404, nothing written.
    const unknown = await fence(randomUUID(), randomUUID(), fromToday(1), 1);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
  });
});
