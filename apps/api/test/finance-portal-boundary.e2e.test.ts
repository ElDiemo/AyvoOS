import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FinancePortalAccess, PortalHotelProfile } from '@ayvo/types';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivedRequestId } from '../src/finance/portal-grants.service.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { isOperational, pragueToday } from '../src/portal-grants/portal-fences.service.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { databaseUrl, hasDatabase } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const portalToken = randomBytes(32).toString('base64url');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const B = '/api/admin/finance/billing';
const G = '/api/admin/finance/portal-grants';
/** This month and the next one in Prague, `YYYY-MM`. */
const thisMonth = () => pragueToday().slice(0, 7);
const nextMonth = () => {
  const d = new Date(`${thisMonth()}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};
const dayBefore = (iso: string) =>
  new Date(new Date(`${iso}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const profileOf = () => ({
  addressLine1: 'Nová 12',
  addressLine2: null,
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

/**
 * Between Finance and the core, for the fence calls only: `pass` forwards; `lost` forwards and
 * then loses the answer (Finance sees 502 — the fence IS written); `down` answers 502 without
 * forwarding; `late` answers 502 at once and forwards the request only when `release()` is called
 * (a request that arrives after Finance gave up on it).
 */
class FenceProxy {
  mode: 'pass' | 'lost' | 'down' | 'late' = 'pass';
  /** Any other contract path answered 502 without forwarding while it matches. */
  down: RegExp | null = null;
  target = 0;
  private held: (() => Promise<number>)[] = [];
  private server!: Server;
  port = 0;

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const fence = /\/portal-fences$/.test(req.url ?? '');
        const mode = fence ? this.mode : this.down?.test(req.url ?? '') ? 'down' : 'pass';
        const forward = () =>
          new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
            (resolve, reject) => {
              const out = httpRequest(
                {
                  host: '127.0.0.1',
                  port: this.target,
                  path: req.url,
                  method: req.method,
                  headers: req.headers,
                },
                (r) => {
                  const parts: Buffer[] = [];
                  r.on('data', (c: Buffer) => parts.push(c));
                  r.on('end', () =>
                    resolve({
                      status: r.statusCode!,
                      headers: r.headers,
                      body: Buffer.concat(parts),
                    }),
                  );
                },
              );
              out.on('error', reject);
              out.end(body);
            },
          );
        const fail = () => res.writeHead(502).end();
        if (mode === 'down') return fail();
        if (mode === 'late') {
          this.held.push(async () => (await forward()).status);
          return fail();
        }
        void forward().then(
          (r) => {
            if (mode === 'lost') return fail();
            res.writeHead(r.status, r.headers as Record<string, string>).end(r.body);
          },
          () => fail(),
        );
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** The held requests reach the core now; their statuses. */
  async release() {
    const held = this.held.splice(0);
    return Promise.all(held.map((f) => f()));
  }

  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

/**
 * Finance A2 of the hotel portal's operational boundary (v6, #148; review 5858166766), end to end
 * over real HTTP between Finance and the core, real databases and runtime roles: a change of payer
 * written on the normal Finance route — never by calling the core's fence by hand — fences the old
 * payer's operations before the change is committed; an explicit restore committed in Finance is
 * the only way back. The old payer's live portal session loses detail, profile read and save on
 * the moved hotel at once and keeps its own historical invoices, their PDFs and the ZIP. A lost
 * answer, an outage and an abandoned change leave Finance knowing every fence there is. A return
 * to an image older than the boundary does not bypass a fence (row-level security), and an older
 * Finance cannot write terms at all. Synthetic payers, hotels, accounts and TEST invoices only.
 */
describe.skipIf(!hasDatabase)('hotel portal: a change of payer through Finance (A2)', () => {
  let f: FinanceTestApp;
  const proxy = new FenceProxy();

  const http = () => request(f.core.app.getHttpServer());
  const portal = (method: 'get' | 'post', path: string, session: string) =>
    http()
      [method](`/api/internal/v1/portal/${path}`)
      .set('Authorization', `Bearer ${portalToken}`)
      .set('x-ayvo-portal-session', session);
  const invoices = (path: string, session: string) =>
    request(f.app.getHttpServer())
      .get(`/api/internal/v1/portal/invoices${path}`)
      .set('Authorization', `Bearer ${portalToken}`)
      .set('x-ayvo-portal-session', session)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  /** The normal terms form of the agreement page: the newest revision, one field changed. */
  async function changeTerms(
    code: string,
    over: Record<string, unknown>,
    requestId = randomUUID(),
  ) {
    const detail = (await f.get(`${B}/agreements/${code}`).expect(200)).body as {
      versions: Record<string, unknown>[];
    };
    const v = detail.versions[0]! as Record<string, unknown> & {
      revision: number;
      customer: { id: string };
    };
    const body = {
      requestId,
      expectedRevision: v.revision,
      terms: {
        effectiveFrom: v.effectiveFrom,
        customerId: v.customer.id,
        contractNumber: v.contractNumber,
        billedRooms: v.billedRooms,
        ownPricePerRoomMonth: v.ownPricePerRoomMonth,
        currency: v.currency,
        paymentTermsDays: v.paymentTermsDays,
        billingTiming: v.billingTiming,
        validFrom: v.validFrom,
        validTo: v.validTo,
        reason: 'Změna podmínek (syntetická)',
        ...over,
      },
    };
    const send = () => f.post(`${B}/agreements/${code}/versions`).send(body);
    return { res: await send(), again: send };
  }

  /** A grant through Finance's own check (the payer page), with a live portal session of it. */
  async function grantOf(payerId: string, hotelIds: string[]) {
    const res = await f.post(G).send({
      requestId: randomUUID(),
      payerCustomerId: payerId,
      email: unique('portal'),
      displayName: 'Recepce',
      hotelIds,
      reason: 'Přístup do portálu (syntetický)',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const userId = res.body.account.userId as string;
    const identity = await f.core.prisma.userIdentity.create({
      data: { userId, provider: 'LOCAL', subject: userId, emailAtLink: res.body.account.email },
    });
    const s = await f.core.prisma.$transaction((tx) =>
      f.core.app.get(SessionsService).create(tx, {
        userId,
        identityId: identity.id,
        providerSessionId: null,
        audience: 'PORTAL',
      }),
    );
    return { grantId: res.body.grant.id as string, session: s.token };
  }
  /** A new check of the grant's hotels (Finance's "Upravit hotely"): a successor grant. */
  async function recheck(grantId: string, hotelIds: string[]) {
    const res = await f.post(`${G}/${grantId}/replace`).send({
      requestId: randomUUID(),
      hotelIds,
      reason: 'Nové ověření (syntetické)',
    });
    return res;
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
      client: { ip: '198.18.0.7', origin: PORTAL_ORIGIN, secFetchSite: 'same-origin' },
    });
    expect([200, 404], JSON.stringify(save.body)).toContain(save.status);
    return { detail, profile: profile.status, save: save.status };
  }
  const OPEN = { detail: 200, profile: 200, save: 200 };
  const CLOSED = { detail: 404, profile: 404, save: 404 };

  const fencesOf = (payerCustomerId: string, hotelId: string) =>
    f.core.prisma.portalOperationalFence.findMany({
      where: { payerCustomerId, hotelId },
      include: { resolution: true },
    });
  const revisionsOf = (code: string) =>
    f.prisma.billingTermsRevision.findMany({
      where: { agreement: { code } },
      include: { events: true },
      orderBy: { revision: 'asc' },
    });
  const access = async (payerId: string) =>
    (await f.get(`${G}?payerCustomerId=${payerId}`).expect(200)).body as FinancePortalAccess;

  beforeAll(async () => {
    await proxy.start();
    f = await createFinanceTestApp({
      coreUrl: `http://127.0.0.1:${proxy.port}`,
      coreEnv: {
        AUTH_PROVIDER: 'local',
        AUTH_MAIL_DRIVER: 'memory',
        PORTAL_PUBLIC_ORIGIN: PORTAL_ORIGIN,
        PORTAL_SERVICE_TOKEN_SHA256: sha(portalToken),
      },
      finance: { PORTAL_FINANCE_TOKEN_SHA256: sha(portalToken) },
    });
    proxy.target = (f.core.app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await f?.close();
    await proxy.close();
  });

  it('an immediate change of payer on the normal route: the live session loses operations, keeps its invoices, PDF and ZIP', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const [h, h2] = [await hotel(f, 'Hotel Přesun'), await hotel(f, 'Hotel Zůstává')];
    const ag = await agreement(f, A.id, h.id);
    await agreement(f, A.id, h2.id);
    const old = await invoice(f, [ag.code], '2026-09');
    const a = await grantOf(A.id, [h.id, h2.id]);
    expect(await reach(a.session, h.id)).toEqual(OPEN);

    const { res } = await changeTerms(ag.code, {
      customerId: Bp.id,
      effectiveFrom: thisMonth(),
      reason: 'Hotel přešel k jinému plátci',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pendingTransfer).toBeNull();

    // The fence was written by Finance's own call, before its commit, for the leaving payer.
    const [fence, ...more] = await fencesOf(A.id, h.id);
    expect(more).toEqual([]);
    expect(fence).toMatchObject({ endsOn: new Date(`${dayBefore(pragueToday())}T00:00:00.000Z`) });
    const transfer = (await revisionsOf(ag.code)).find((r) => r.intent === 'TRANSFER')!;
    expect(transfer).toMatchObject({ revision: 2, payerCustomerId: A.id });
    expect(fence!.termsRevision).toBe(2);
    expect(fence!.requestId).toBe(derivedRequestId(transfer.requestId, 'portal-fence'));
    const fenced = transfer.events.find((e) => e.kind === 'FENCED')!;
    const committed = transfer.events.find((e) => e.kind === 'COMMITTED')!;
    expect(fenced.fenceId).toBe(fence!.id);
    const version = await f.prisma.agreementVersion.findUniqueOrThrow({
      where: { id: committed.agreementVersionId! },
    });
    expect(version).toMatchObject({ customerId: Bp.id, termsRevision: 2 });
    expect(fence!.createdAt.getTime()).toBeLessThanOrEqual(version.recordedAt.getTime());

    // The SAME live session: no operations on the moved hotel, the other hotel unchanged.
    expect(await reach(a.session, h.id)).toEqual(CLOSED);
    expect(await reach(a.session, h2.id)).toEqual(OPEN);
    const list = (await portal('get', 'hotels', a.session).expect(200)).body as { id: string }[];
    expect(list.map((x) => x.id)).toEqual([h2.id]);
    // …and its own historical invoice of the moved hotel: in the list, its PDF, the ZIP.
    const page = JSON.parse((await invoices('', a.session).expect(200)).body.toString());
    expect(page.items.map((i: { id: string }) => i.id)).toContain(old.id);
    const pdf = await invoices(`/${old.id}/pdf`, a.session).expect(200);
    expect(sha(pdf.body as Buffer)).toBe(old.pdfSha256);
    const zip = await invoices('/package?from=2026-09&to=2026-09', a.session).expect(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect((zip.body as Buffer).includes(Buffer.from(old.number))).toBe(true);

    // The new payer: operations after its own check. The old payer's new check: invoices only.
    const b = await grantOf(Bp.id, [h.id]);
    expect(await reach(b.session, h.id)).toEqual(OPEN);
    const again = await recheck(a.grantId, [h.id, h2.id]);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const hotels = await f.core.prisma.portalGrantHotel.findMany({
      where: { grantId: again.body.grant.id },
      select: { hotelId: true, access: true },
    });
    expect(hotels).toContainEqual({ hotelId: h.id, access: 'INVOICES' });
    // The payer page names the restriction (Finance's own records), no restore yet.
    expect((await access(A.id)).restrictions).toEqual([
      expect.objectContaining({ fenceId: fence!.id, hotelId: h.id, restore: null }),
    ]);

    // A return to an older image after this: its connections lack the boundary marker, and the
    // database shows them the old payer's grant without the fenced hotel (row-level security).
    const older = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    try {
      const seen = await older.portalGrantHotel.findMany({ where: { grantId: a.grantId } });
      expect(seen.map((x) => x.hotelId)).toEqual([h2.id]);
      // The new payer's hotel is unaffected; no older image writes a grant's hotel.
      expect(await older.portalGrantHotel.count({ where: { grantId: b.grantId } })).toBe(1);
      await expect(
        older.$executeRawUnsafe(
          `INSERT INTO "portal_grant_hotels" ("grant_id", "hotel_id", "access", "checked_revision")
           VALUES ($1::uuid, $2::uuid, 'OPERATIONS', 9)`,
          a.grantId,
          h.id,
        ),
      ).rejects.toThrow(/row-level security|written with the grant/);
    } finally {
      await older.$disconnect();
    }
    // The current image (the marker) sees every hotel of the grant, as before.
    expect(await f.core.prisma.portalGrantHotel.count({ where: { grantId: a.grantId } })).toBe(2);
  });

  it('a change of payer from next month: operations until the last day of this month, then none', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const h = await hotel(f);
    const ag = await agreement(f, A.id, h.id);
    const a = await grantOf(A.id, [h.id]);
    const { res } = await changeTerms(ag.code, { customerId: Bp.id, effectiveFrom: nextMonth() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [fence] = await fencesOf(A.id, h.id);
    expect(fence!.endsOn.toISOString().slice(0, 10)).toBe(dayBefore(`${nextMonth()}-01`));
    // Today: still open. On the first day of the next month the same rule closes it.
    expect(await reach(a.session, h.id)).toEqual(OPEN);
    const row = await f.core.prisma.portalGrantHotel.findFirstOrThrow({
      where: { grantId: a.grantId, hotelId: h.id },
    });
    expect(isOperational(row, [{ ...fence!, resolution: null }], `${nextMonth()}-01`)).toBe(false);
    expect(isOperational(row, [{ ...fence!, resolution: null }], pragueToday())).toBe(true);
  });

  it('the fence’s answer lost: the change stays reserved and fails closed; the same request finishes it with the same fence', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const h = await hotel(f);
    const ag = await agreement(f, A.id, h.id);
    const a = await grantOf(A.id, [h.id]);
    proxy.mode = 'lost';
    const first = await changeTerms(ag.code, { customerId: Bp.id, effectiveFrom: thisMonth() });
    proxy.mode = 'pass';
    expect([first.res.status, first.res.body.code]).toEqual([
      503,
      'FINANCE_DEPENDENCY_UNAVAILABLE',
    ]);
    // Written at the core, not committed in Finance: the old payer is closed already.
    expect(await fencesOf(A.id, h.id)).toHaveLength(1);
    expect(await reach(a.session, h.id)).toEqual(CLOSED);
    const detail = (await f.get(`${B}/agreements/${ag.code}`).expect(200)).body;
    expect(detail.pendingTransfer).toMatchObject({ termsRevision: 2, leavingPayer: { id: A.id } });
    expect(detail.versions).toHaveLength(1);
    // Nothing else of the agreement meanwhile, and no grant check against its terms.
    const other = await changeTerms(ag.code, { billedRooms: 20 });
    expect([other.res.status, other.res.body.code]).toEqual([409, 'TERMS_CHANGE_PENDING']);
    const check = await f.post(G).send({
      requestId: randomUUID(),
      payerCustomerId: A.id,
      email: unique('portal'),
      displayName: 'Recepce',
      hotelIds: [h.id],
      reason: 'Přístup (syntetický)',
    });
    expect([check.status, check.body.code]).toEqual([409, 'TERMS_CHANGE_PENDING']);

    const retry = await first.again();
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.pendingTransfer).toBeNull();
    expect(await fencesOf(A.id, h.id)).toHaveLength(1);
    const [, transfer] = await revisionsOf(ag.code);
    expect(transfer!.events.map((e) => e.kind).sort()).toEqual(['COMMITTED', 'FENCED']);
    // And replayed once more: the stored answer, nothing new.
    expect((await first.again()).status).toBe(201);
    expect(await f.prisma.agreementVersion.count({ where: { agreement: { code: ag.code } } })).toBe(
      2,
    );
  });

  it('the core down: "Dokončit" finishes it later; "Zrušit" of another settles its fence request so a late one writes nothing', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const [h, h2] = [await hotel(f), await hotel(f)];
    const ag = await agreement(f, A.id, h.id);
    const ag2 = await agreement(f, A.id, h2.id);

    proxy.mode = 'down';
    expect(
      (await changeTerms(ag.code, { customerId: Bp.id, effectiveFrom: thisMonth() })).res.status,
    ).toBe(503);
    proxy.mode = 'pass';
    expect(await fencesOf(A.id, h.id)).toEqual([]);
    const done = await f.post(`${B}/agreements/${ag.code}/transfers/2/finish`).send({});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.versions[0].customer.id).toBe(Bp.id);
    expect(await fencesOf(A.id, h.id)).toHaveLength(1);

    proxy.mode = 'late';
    expect(
      (await changeTerms(ag2.code, { customerId: Bp.id, effectiveFrom: thisMonth() })).res.status,
    ).toBe(503);
    proxy.mode = 'pass';
    const abandoned = await f.post(`${B}/agreements/${ag2.code}/transfers/2/abandon`).send({});
    expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(200);
    expect(abandoned.body.pendingTransfer).toBeNull();
    expect(abandoned.body.versions).toHaveLength(1);
    // The request Finance gave up on arrives now: the core refuses it, no fence is ever written.
    expect(await proxy.release()).toEqual([409]);
    expect(await fencesOf(A.id, h2.id)).toEqual([]);
    const [, transfer] = await revisionsOf(ag2.code);
    expect(transfer!.events.map((e) => e.kind)).toEqual(['ABANDONED']);
    // Abandoned is final: finishing it is refused, abandoning it again changes nothing.
    const late = await f.post(`${B}/agreements/${ag2.code}/transfers/2/finish`).send({});
    expect([late.status, late.body.code]).toEqual([409, 'TRANSFER_ABANDONED']);
    expect((await f.post(`${B}/agreements/${ag2.code}/transfers/2/abandon`).send({})).status).toBe(
      200,
    );
  });

  it('v6 test 5: an abandoned transfer’s fence; a price revision never restores; only a committed RESTORE and a check after it do', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const C = await payer(f, 'Plátce C');
    const h = await hotel(f);
    const ag = await agreement(f, A.id, h.id);
    const other = await agreement(f, C.id, (await hotel(f)).id);
    const old = await invoice(f, [ag.code], '2026-09');
    const a = await grantOf(A.id, [h.id]);

    // r2: a transfer whose fence is written (the answer lost), then abandoned in Finance.
    proxy.mode = 'lost';
    await changeTerms(ag.code, { customerId: Bp.id, effectiveFrom: thisMonth() });
    proxy.mode = 'pass';
    const abandoned = await f.post(`${B}/agreements/${ag.code}/transfers/2/abandon`).send({});
    expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(200);
    expect(abandoned.body.versions.map((v: { customer: { id: string } }) => v.customer.id)).toEqual(
      [A.id],
    );
    const [f2] = await fencesOf(A.id, h.id);
    const r2 = (await revisionsOf(ag.code))[1]!;
    expect(r2.events.map((e) => [e.kind, e.fenceId])).toEqual([
      ['FENCED', f2!.id],
      ['ABANDONED', null],
    ]);
    expect((await access(A.id)).restrictions).toEqual([
      expect.objectContaining({ fenceId: f2!.id, termsRevision: 2, restore: null }),
    ]);

    // r3: a committed price revision (higher than r2): no resolution reaches the core.
    const price = await changeTerms(ag.code, { ownPricePerRoomMonth: '380.00' });
    expect(price.res.status, JSON.stringify(price.res.body)).toBe(201);
    expect((await revisionsOf(ag.code))[2]).toMatchObject({ revision: 3, intent: 'CHANGE' });
    const resolutions = () =>
      f.core.prisma.portalOperationalFenceResolution.count({ where: { fenceId: f2!.id } });
    expect(await resolutions()).toBe(0);
    // A restore that names the price revision instead of a RESTORE: 409 in Finance, nothing sent.
    const wrong = await f.post(`${B}/agreements/${ag.code}/restores/3/send`).send({});
    expect([wrong.status, wrong.body.code]).toEqual([409, 'NOT_A_RESTORE']);
    expect(await resolutions()).toBe(0);
    // A fresh check at r3: OPERATIONS checked in r3 — still closed by the unresolved fence.
    const fresh = await recheck(a.grantId, [h.id]);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    const freshSession = a.session;
    expect(await reach(freshSession, h.id)).toEqual(CLOSED);
    expect(
      JSON.parse((await invoices('', freshSession).expect(200)).body.toString()).items.map(
        (i: { id: string }) => i.id,
      ),
    ).toContain(old.id);

    // Refused restores: a foreign fence, a payer whose terms are not in effect, an unknown id.
    const restore = (code: string, body: Record<string, unknown>) =>
      f
        .post(`${B}/agreements/${code}/restores`)
        .send({ requestId: randomUUID(), reason: 'Obnova (syntetická)', ...body });
    const foreign = await restore(other.code, { payerCustomerId: C.id, fenceIds: [f2!.id] });
    expect([foreign.status, foreign.body.code]).toEqual([409, 'FENCE_NOT_OF_PAYER']);
    const notPayer = await restore(ag.code, { payerCustomerId: Bp.id, fenceIds: [f2!.id] });
    expect([notPayer.status, notPayer.body.code]).toEqual([409, 'RESTORE_NOT_PAYER']);
    const unknown = await restore(ag.code, { payerCustomerId: A.id, fenceIds: [randomUUID()] });
    expect([unknown.status, unknown.body.code]).toEqual([409, 'FENCE_NOT_OF_PAYER']);
    expect(await resolutions()).toBe(0);

    // r4: the explicit restore, committed in Finance, then accepted by the core.
    const requestId = randomUUID();
    const ok = await restore(ag.code, { requestId, payerCustomerId: A.id, fenceIds: [f2!.id] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toEqual({ termsRevision: 4, fenceIds: [f2!.id], sent: true });
    const [resolved] = await fencesOf(A.id, h.id);
    expect(resolved!.resolution).toMatchObject({ restoreRevision: 4 });
    expect(resolved!.resolution!.restoreRequestId).toBe(requestId);
    // The grant checked in r3 (before the restore) stays closed; a check after it opens it.
    expect(await reach(freshSession, h.id)).toEqual(CLOSED);
    const after = await recheck(fresh.body.grant.id, [h.id]);
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect(await reach(freshSession, h.id)).toEqual(OPEN);
    expect((await access(A.id)).restrictions).toEqual([]);

    // A replay of the restore: the same evidence, one resolution. Another restore of it: 409.
    const replay = await restore(ag.code, { requestId, payerCustomerId: A.id, fenceIds: [f2!.id] });
    expect(replay.status).toBe(201);
    expect(await resolutions()).toBe(1);
    const twice = await restore(ag.code, { payerCustomerId: A.id, fenceIds: [f2!.id] });
    expect([twice.status, twice.body.code]).toEqual([409, 'FENCE_ALREADY_RESTORED']);
  });

  it('a restore committed while the core is down is sent again later, the same evidence', async () => {
    const A = await payer(f, 'Plátce A');
    const Bp = await payer(f, 'Plátce B');
    const h = await hotel(f);
    const ag = await agreement(f, A.id, h.id);
    proxy.mode = 'lost';
    await changeTerms(ag.code, { customerId: Bp.id, effectiveFrom: thisMonth() });
    proxy.mode = 'pass';
    await f.post(`${B}/agreements/${ag.code}/transfers/2/abandon`).send({}).expect(200);
    const [fence] = await fencesOf(A.id, h.id);

    // The core unreachable for the resolution: the restore is committed, not sent.
    proxy.down = /\/portal-fence-resolutions$/;
    const res = await f.post(`${B}/agreements/${ag.code}/restores`).send({
      requestId: randomUUID(),
      payerCustomerId: A.id,
      fenceIds: [fence!.id],
      reason: 'Obnova (syntetická)',
    });
    proxy.down = null;
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ termsRevision: 3, sent: false });
    expect((await fencesOf(A.id, h.id))[0]!.resolution).toBeNull();
    expect((await access(A.id)).restrictions).toEqual([
      expect.objectContaining({ fenceId: fence!.id, restore: { termsRevision: 3, sent: false } }),
    ]);
    const sent = await f.post(`${B}/agreements/${ag.code}/restores/3/send`).send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await fencesOf(A.id, h.id))[0]!.resolution).toMatchObject({ restoreRevision: 3 });
    expect((await access(A.id)).restrictions).toEqual([]);
  });

  it('an older Finance image cannot write terms (no terms revision), so never a change of payer without its fence', async () => {
    const A = await payer(f, 'Plátce A');
    const h = await hotel(f);
    const ag = await agreement(f, A.id, h.id);
    const row = await f.prisma.billingAgreement.findUniqueOrThrow({ where: { code: ag.code } });
    const older = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    try {
      await expect(
        older.$executeRawUnsafe(
          `INSERT INTO "finance"."agreement_versions" ("revision", "agreement_id", "effective_from",
             "customer_id", "billed_rooms", "currency", "payment_terms_days", "billing_timing",
             "valid_from", "reason", "recorded_by", "recorded_by_name", "request_id")
           VALUES (999999, $1::uuid, '2026-01-01', $2::uuid, 1, 'CZK', 14, 'ARREARS', '2026-01-01',
             'old image', $3::uuid, 'Old', $4::uuid)`,
          row.id,
          A.id,
          randomUUID(),
          randomUUID(),
        ),
      ).rejects.toThrow(/terms_revision/);
    } finally {
      await older.$disconnect();
    }
  });
});
