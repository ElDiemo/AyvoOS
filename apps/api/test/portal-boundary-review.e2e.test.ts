import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PortalHotelProfile } from '@ayvo/types';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { pragueToday } from '../src/portal-grants/portal-fences.service.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
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
 * Independent review of #180 (Finance A2) on #148 (A1 + A2 + contracts), the owner's scenarios of
 * #169 (comment 6796629715) that the A2 acceptance does not cover: a return to an image older than
 * the boundary with an invoices-only grant hotel that no fence closes (a payer changed before A2);
 * a change of payer by an EARLIER END of the terms on the normal route; the old payer's signed
 * contracts (list and PDF) after a change of payer. Real core and Finance over HTTP, runtime
 * roles, synthetic data only.
 */
describe.skipIf(!hasDatabase)('hotel portal A2 — independent review negatives (#180)', () => {
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

  it('an older image never opens an invoices-only grant hotel that no fence closes (a payer changed before A2)', async () => {
    const A = await payer(f, 'Plátce dřívější');
    const Bp = await payer(f, 'Plátce nynější');
    const h = await hotel(f, 'Hotel dříve převedený');
    const ag = await agreement(f, A.id, h.id);
    const old = await invoice(f, [ag.code], '2026-09');
    // The change of payer as Finance wrote it BEFORE A2: a version naming B, no terms revision of
    // a transfer, no fence (the backfill numbered it like any other version).
    const a1 = await f.prisma.billingAgreement.findUniqueOrThrow({
      where: { code: ag.code },
      include: { versions: true },
    });
    const { id, recordedAt, ...v } = a1.versions[0]!;
    void id;
    void recordedAt;
    await f.prisma.agreementVersion.create({
      data: {
        ...v,
        customerId: Bp.id,
        revision: v.revision + 1000n,
        termsRevision: 2,
        requestId: randomUUID(),
      } as never,
    });
    expect(await fencesOf(A.id, h.id)).toEqual([]);
    // The former payer's grant for its historical invoices: Finance's check gives INVOICES only.
    const a = await grantOf(A.id, [h.id]);
    const rows = await f.core.prisma.portalGrantHotel.findMany({ where: { grantId: a.grantId } });
    expect(rows.map((r) => [r.hotelId, r.access])).toEqual([[h.id, 'INVOICES']]);
    expect(await reach(a.session, h.id)).toEqual(CLOSED);
    const pdf = await invoices(`/${old.id}/pdf`, a.session).expect(200);
    expect(sha(pdf.body as Buffer)).toBe(old.pdfSha256);

    // A return to an image older than A1: it does not know `access` and opens every hotel it
    // reads. The database must not show it this invoices-only hotel at all.
    const older = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    try {
      const seen = await older.portalGrantHotel.findMany({ where: { grantId: a.grantId } });
      expect(seen.map((x) => x.hotelId)).toEqual([]);
    } finally {
      await older.$disconnect();
    }
    // The current image still sees it (its own rule: invoices only).
    expect(await f.core.prisma.portalGrantHotel.count({ where: { grantId: a.grantId } })).toBe(1);
  });

  it('an earlier end of the terms on the normal route is a transfer: fenced before it is committed', async () => {
    const A = await payer(f, 'Plátce končí dříve');
    const h = await hotel(f, 'Hotel s dřívějším koncem');
    const ag = await agreement(f, A.id, h.id);
    const a = await grantOf(A.id, [h.id]);
    expect(await reach(a.session, h.id)).toEqual(OPEN);
    // The terms now end on the last day of this month instead of never: the same payer, no other.
    const endOfMonth = dayBefore(`${nextMonth()}-01`);
    const { res } = await changeTerms(ag.code, {
      validTo: endOfMonth,
      reason: 'Smlouva skončí dříve (syntetická)',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const revisions = await revisionsOf(ag.code);
    const transfer = revisions.find((r) => r.intent === 'TRANSFER')!;
    expect(transfer, JSON.stringify(revisions.map((r) => r.intent))).toBeTruthy();
    expect(transfer.payerCustomerId).toBe(A.id);
    const fenced = transfer.events.find((e) => e.kind === 'FENCED')!;
    const committed = transfer.events.find((e) => e.kind === 'COMMITTED')!;
    expect(fenced && committed).toBeTruthy();
    const [fence, ...more] = await fencesOf(A.id, h.id);
    expect(more).toEqual([]);
    expect(fence!.id).toBe(fenced.fenceId);
    expect(fence!.endsOn).toEqual(new Date(`${endOfMonth}T00:00:00.000Z`));
    // Until then the payer keeps its operations (today ≤ the end); the fence closes them after.
    expect(await reach(a.session, h.id)).toEqual(OPEN);
    // A later price change (a CHANGE) never lifts that fence.
    const price = await changeTerms(ag.code, {
      reason: 'Jen nová cena (syntetická)',
      billedRooms: 41,
    });
    expect(price.res.status, JSON.stringify(price.res.body)).toBe(201);
    expect((await fencesOf(A.id, h.id)).map((x) => [x.id, x.resolution])).toEqual([
      [fence!.id, null],
    ]);
  });

  it('the old payer’s signed contracts after a change of payer: list and PDF 404, the new payer’s check opens them', async () => {
    const A = await payer(f, 'Plátce A smlouvy');
    const Bp = await payer(f, 'Plátce B smlouvy');
    const h = await hotel(f, 'Hotel se smlouvou');
    const ag = await agreement(f, A.id, h.id);
    const a = await grantOf(A.id, [h.id]);
    expect((await portal('get', `hotels/${h.id}/contracts`, a.session)).status).toBe(200);
    const { res } = await changeTerms(ag.code, {
      customerId: Bp.id,
      effectiveFrom: thisMonth(),
      reason: 'Hotel přešel k jinému plátci',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await portal('get', `hotels/${h.id}/contracts`, a.session)).status).toBe(404);
    // A contract id the old payer may have kept from before: its PDF is not found either.
    expect((await portal('get', `contracts/${randomUUID()}/pdf`, a.session)).status).toBe(404);
    const b = await grantOf(Bp.id, [h.id]);
    expect((await portal('get', `hotels/${h.id}/contracts`, b.session)).status).toBe(200);
  });
});
