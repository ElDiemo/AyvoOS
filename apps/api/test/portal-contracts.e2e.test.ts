import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  ContractDraftDetail,
  ContractDraftFields,
  HotelDetail,
  PortalContract,
} from '@ayvo/types';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderContractPdf } from '../src/contracts/contract-pdf.js';
import { contractDocument } from '../src/contracts/contract-template.js';
import { InvitationsService } from '../src/identity/invitations.service.js';
import { NativeTokensService } from '../src/identity/native-tokens.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { PortalRequestLimit } from '../src/portal/portal-request-limit.js';
import { createHotel } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const PORTAL_ORIGIN = 'https://portal.example.test';
const PASSWORD = 'Dlouhe portalove heslo AYVO 789';
const D = '/api/admin/contracts/drafts';
const portalToken = randomBytes(32).toString('base64url');
const financeToken = randomBytes(32).toString('base64url');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const MAX_READ = 1024 * 1024;
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
const otp = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
const client = () => ({
  ip: `198.18.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`,
  origin: PORTAL_ORIGIN,
  secFetchSite: 'same-origin',
});

/**
 * "Smlouvy" through the core's portal contract and the real database: a hotel account sees and
 * downloads only the signed originals of drafts linked to its granted hotels — never a draft, a
 * revision without a signed original, or another hotel's contract; the file is the one AYVO
 * uploaded (hash), the download is recorded with the portal account; a revoked grant ends access.
 * Synthetic accounts, hotels and contracts only.
 */
describe.skipIf(!hasDatabase)('hotel portal: signed contracts', () => {
  let t: TestApp;
  let su: TestApp;
  let adminId: string;
  let hotelA: HotelDetail;
  let hotelB: HotelDetail;
  let signedA: { id: string; pdf: Buffer; draft: string };
  let signedB: { id: string };

  const core = () => request(t.app.getHttpServer());
  const staff = () => request(su.app.getHttpServer());
  const get = (path: string, session?: string, token = portalToken) => {
    const r = core().get(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${token}`);
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const post = (path: string) =>
    core().post(`/api/internal/v1/portal/${path}`).set('Authorization', `Bearer ${portalToken}`);
  const grant = (userId: string, hotelIds: string[]) =>
    t.app.get(PortalGrantsService).issue(adminId, {
      requestId: randomUUID(),
      userId,
      payerCustomerId: randomUUID(),
      hotelIds,
      reason: 'synthetic portal grant',
      financeCheck: { payerVersion: 1, hotelIds, checkedAt: new Date().toISOString() },
    });
  const pdfBody = (res: request.Response) => res.body as Buffer;

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

  const fields = (hotel: HotelDetail, over: Partial<ContractDraftFields> = {}) =>
    ({
      counterpartyName: `Hotelová společnost ${hotel.code} s.r.o.`,
      counterpartyCompanyId: '12345678',
      counterpartyAddress: 'Ukázková 1, 602 00 Brno',
      representativeName: 'Jana Ukázková',
      representativeRole: 'jednatelka',
      hotelName: hotel.name,
      hotelAddress: `${hotel.address.addressLine1}, ${hotel.address.postalCode} ${hotel.address.city}`,
      rooms: 40,
      pricePerRoomMonth: '120.50',
      currency: 'CZK',
      startOn: '2027-01-01',
      billingTiming: 'ARREARS',
      paymentTermsDays: 14,
      holders: 'NONE',
      holdersOwnership: null,
      ...over,
    }) satisfies ContractDraftFields;

  /** A draft linked to the hotel, as staff create it; signed (uploaded) when asked. */
  async function contract(hotel: HotelDetail, sign: string | null, startOn = '2027-01-01') {
    const created = await staff()
      .post(D)
      .send({
        requestId: randomUUID(),
        prospectCode: null,
        hotelCode: hotel.code,
        fields: fields(hotel, { startOn }),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const d = created.body as ContractDraftDetail;
    if (!sign) return { draft: d.code, id: null, pdf: null };
    const pdf = await renderContractPdf(
      contractDocument('cs-b2b-1', {
        code: d.code,
        revision: d.currentRevision,
        savedOn: sign,
        fields: fields(hotel, { startOn }),
      }),
    );
    let req = staff().post(`${D}/${d.code}/signed`);
    for (const [k, v] of Object.entries({
      requestId: randomUUID(),
      expectedVersion: String(d.version),
      revision: String(d.currentRevision),
      signedOn: sign,
      confirm: 'true',
    }))
      req = req.field(k, v);
    const up = await req.attach('file', pdf, 'Smlouva podepsaná.pdf');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const doc = await t.prisma.contractSignedDocument.findFirstOrThrow({
      where: { revisionRow: { draft: { code: d.code } } },
    });
    // Each test app has its own storage directory: the portal's app reads the same file.
    await t.storage.put(doc.storageKey, pdf);
    return { draft: d.code, id: doc.id, pdf };
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
        // The portal app only reads signed originals (uploads go through `su`): a small read limit
        // and a short deadline make the bounded-read tests fast.
        SUPPLIER_DOCUMENT_MAX_BYTES: String(MAX_READ),
        PORTAL_CONTRACT_PDF_TIMEOUT_MS: '1000',
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    su = await createTestApp();
    adminId = (
      await t.prisma.user.create({ data: { email: unique('grant-admin'), displayName: 'Admin' } })
    ).id;
    hotelA = await createHotel(su, { name: `Hotel Smlouva A ${randomUUID().slice(0, 4)}` });
    hotelB = await createHotel(su, { name: `Hotel Smlouva B ${randomUUID().slice(0, 4)}` });
    const a = await contract(hotelA, '2026-10-15', '2026-11-01');
    signedA = { id: a.id!, pdf: a.pdf!, draft: a.draft };
    await contract(hotelA, null); // a draft only: never in the portal
    signedB = { id: (await contract(hotelB, '2026-10-20')).id! };
  });
  afterAll(async () => {
    await t?.close();
    await su?.close();
  });

  it('lists only the granted hotel’s signed originals — no drafts, no other hotel', async () => {
    const a = await account();
    await grant(a.user.id, [hotelA.id]);
    const res = await get(`hotels/${hotelA.id}/contracts`, a.session);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = res.body as PortalContract[];
    expect(list).toEqual([
      {
        id: signedA.id,
        signedOn: '2026-10-15',
        startOn: '2026-11-01',
        byteSize: signedA.pdf.length,
      },
    ]);
    // Nothing of the draft: no code, prices, counterparty or template.
    expect(Object.keys(list[0]!).sort()).toEqual(['byteSize', 'id', 'signedOn', 'startOn']);
    for (const id of [hotelB.id, randomUUID()]) {
      const r = await get(`hotels/${id}/contracts`, a.session);
      expect([r.status, r.body.code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    }
    expect((await get(`hotels/${hotelA.id}/contracts`)).status).toBe(401);
    expect((await get(`hotels/${hotelA.id}/contracts`, a.session, financeToken)).status).toBe(401);
  });

  it('downloads the original as uploaded and records it; another hotel’s or unknown is 404', async () => {
    const a = await account();
    await grant(a.user.id, [hotelA.id]);
    const res = await get(`contracts/${signedA.id}/pdf`, a.session)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="AYVO-smlouva-2026-10-15.pdf"',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(sha(pdfBody(res))).toBe(sha(signedA.pdf));
    const event = await t.prisma.contractDraftEvent.findFirstOrThrow({
      where: { draft: { code: signedA.draft }, kind: 'SIGNED_DOWNLOADED' },
      orderBy: { at: 'desc' },
    });
    expect(event).toMatchObject({ actorId: a.user.id, details: { via: 'PORTAL' } });
    for (const id of [signedB.id, randomUUID()]) {
      const r = await get(`contracts/${id}/pdf`, a.session);
      expect([r.status, r.body.code]).toEqual([404, 'CONTRACT_NOT_FOUND']);
    }
  });

  it('a revoked grant ends access to the hotel’s contracts', async () => {
    const a = await account();
    await grant(a.user.id, [hotelB.id]); // keeps the session alive
    const g = await grant(a.user.id, [hotelA.id]);
    expect((await get(`contracts/${signedA.id}/pdf`, a.session)).status).toBe(200);
    await t.app.get(PortalGrantsService).revoke(adminId, g.id, 'synthetic revocation');
    expect((await get(`hotels/${hotelA.id}/contracts`, a.session)).status).toBe(404);
    expect((await get(`contracts/${signedA.id}/pdf`, a.session)).status).toBe(404);
    expect((await get(`contracts/${signedB.id}/pdf`, a.session)).status).toBe(200);
  });

  describe('review 5841786998: the PDF read in the core is bounded work', () => {
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const downloads = () =>
      t.prisma.contractDraftEvent.count({
        where: { draft: { code: signedA.draft }, kind: 'SIGNED_DOWNLOADED' },
      });

    it('a hanging storage: 503 at the deadline, the read really stopped and the slot free; the portal and the internal OS keep answering meanwhile', async () => {
      const a = await account();
      await grant(a.user.id, [hotelA.id]);
      const slots = t.app.get(PortalRequestLimit);
      const before = await downloads();
      t.storage.virtualSizeBytes = 512 * 1024; // 8 chunks…
      t.storage.delayGetsMs = 400; // …far beyond the 1 s deadline
      try {
        for (let series = 0; series < 2; series++) {
          const started = Date.now();
          const pending = [0, 1].map(() => get(`contracts/${signedA.id}/pdf`, a.session).then());
          await settle(150);
          // While both reads hang: other portal work and the internal OS answer at once.
          const [list, health] = await Promise.all([
            get(`hotels/${hotelA.id}/contracts`, a.session),
            core().get('/api/health'),
          ]);
          expect([list.status, health.status]).toEqual([200, 200]);
          const answers = await Promise.all(pending);
          expect(answers.map((r) => [r.status, r.body.code])).toEqual([
            [503, 'CONTRACT_UNAVAILABLE'],
            [503, 'CONTRACT_UNAVAILABLE'],
          ]);
          expect(Date.now() - started).toBeLessThan(2500);
          // The slots were released only after the reads had really stopped.
          expect([slots.inFlight, t.storage.activeReads]).toEqual([0, 0]);
          const read = t.storage.bytesRead;
          await settle(500);
          expect(t.storage.bytesRead).toBe(read);
        }
      } finally {
        t.storage.virtualSizeBytes = 0;
        t.storage.delayGetsMs = 0;
      }
      // Nothing was recorded as downloaded; the original is served again once storage is back.
      expect(await downloads()).toBe(before);
      expect((await get(`contracts/${signedA.id}/pdf`, a.session)).status).toBe(200);
    });

    it('an oversized object: the read stops at the limit, never the whole object, nothing recorded', async () => {
      const a = await account();
      await grant(a.user.id, [hotelA.id]);
      const before = await downloads();
      const read = t.storage.bytesRead;
      t.storage.virtualSizeBytes = 64 * MAX_READ;
      try {
        const res = await get(`contracts/${signedA.id}/pdf`, a.session);
        expect([res.status, res.body.code]).toEqual([503, 'CONTRACT_UNAVAILABLE']);
      } finally {
        t.storage.virtualSizeBytes = 0;
      }
      expect(t.storage.bytesRead - read).toBeLessThanOrEqual(MAX_READ + 64 * 1024);
      expect(t.storage.activeReads).toBe(0);
      expect(t.app.get(PortalRequestLimit).inFlight).toBe(0);
      expect(await downloads()).toBe(before);
    });
  });
});
