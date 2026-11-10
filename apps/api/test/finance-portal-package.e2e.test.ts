import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PORTAL_PACKAGE_MAX_MS, PORTAL_PACKAGE_MAX_ZIP_BYTES } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FINANCE_ENV, financeEnvSchema, type FinanceEnv } from '../src/finance/finance-env.js';
import { SessionsService } from '../src/identity/sessions.service.js';
import { PortalGrantsService } from '../src/portal-grants/portal-grants.service.js';
import { createFinanceTestApp, type FinanceTestApp } from './support/finance-app.js';
import { agreement, hotel, invoice, payer } from './support/finance-portal.js';
import { hasDatabase } from './support/test-app.js';

const portalToken = randomBytes(32).toString('base64url');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const unique = (p: string) => `${p}-${randomUUID().slice(0, 8)}@ayvo.test`;
const P = '/api/internal/v1/portal/invoices';

/** The entries of a STORE-only ZIP (as Finance writes it): name → bytes. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.set(name, zip.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

/**
 * "Balíček za období" of the hotel portal (doc 040 §14) in Finance: the visible invoices of the
 * period (THE predicate of the list, detail and PDF) as one ZIP — each invoice once, a summary
 * invoice only for a grant that covers it whole — with manifest.csv and the PDFs exactly as issued;
 * bounded in months, documents and bytes. Synthetic payers, hotels and TEST invoices only.
 */
describe.skipIf(!hasDatabase)('hotel portal: invoice package for a period', () => {
  let f: FinanceTestApp;
  let actorId: string;
  let ids: Record<'A1' | 'A2' | 'B1', string>;
  let h: Record<'H1' | 'H2' | 'H3', string>;
  let payers: Record<'A' | 'B', string>;

  const pkg = (query: string, session?: string, token = portalToken) => {
    const r = request(f.app.getHttpServer())
      .get(`${P}/package${query}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return session ? r.set('x-ayvo-portal-session', session) : r;
  };
  const json = (body: unknown) => JSON.parse((body as Buffer).toString('utf8'));

  async function account(grants: { payer: string; hotels: string[] }[]) {
    const user = await f.core.prisma.user.create({
      data: { email: unique('portal'), displayName: 'Portal', audience: 'PORTAL' },
    });
    for (const g of grants)
      await f.core.app.get(PortalGrantsService).issue(actorId, {
        requestId: randomUUID(),
        userId: user.id,
        payerCustomerId: g.payer,
        hotelIds: g.hotels,
        reason: 'synthetic portal grant',
        financeCheck: { payerVersion: 1, hotelIds: g.hotels, checkedAt: new Date().toISOString() },
      });
    const identity = await f.core.prisma.userIdentity.create({
      data: { userId: user.id, provider: 'LOCAL', subject: user.id, emailAtLink: user.email },
    });
    const s = await f.core.prisma.$transaction((tx) =>
      f.core.app.get(SessionsService).create(tx, {
        userId: user.id,
        identityId: identity.id,
        providerSessionId: null,
        audience: 'PORTAL',
      }),
    );
    return s.token;
  }

  beforeAll(async () => {
    f = await createFinanceTestApp({
      finance: {
        PORTAL_FINANCE_TOKEN_SHA256: sha(portalToken),
        FINANCE_PORTAL_PACKAGE_MAX_INVOICES: '2',
      },
    });
    actorId = (
      await f.core.prisma.user.create({ data: { email: unique('admin'), displayName: 'Admin' } })
    ).id;
    const A = await payer(f, 'Plátce A');
    const B = await payer(f, 'Plátce B');
    payers = { A: A.id, B: B.id };
    const [h1, h2, h3] = [await hotel(f), await hotel(f), await hotel(f)];
    h = { H1: h1.id, H2: h2.id, H3: h3.id };
    const a1 = await agreement(f, A.id, h1.id);
    const a2 = await agreement(f, A.id, h2.id);
    const b3 = await agreement(f, B.id, h3.id);
    const A1 = await invoice(f, [a1.code], '2026-08');
    const A2 = await invoice(f, [a1.code, a2.code], '2026-09'); // a summary over H1 and H2
    const B1 = await invoice(f, [b3.code], '2026-09');
    ids = { A1: A1.id, A2: A2.id, B1: B1.id };
  });
  afterAll(() => f?.close());

  it('one grant over H1 + H2: its invoices of the period, the summary once, PDFs as issued', async () => {
    const session = await account([{ payer: payers.A, hotels: [h.H1, h.H2] }]);
    const res = await pkg('?from=2026-08&to=2026-10', session);
    expect(res.status, (res.body as Buffer).toString().slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="AYVO-faktury-2026-08-2026-10.zip"',
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const files = unzip(res.body as Buffer);
    const stored = await f.prisma.invoice.findMany({
      where: { id: { in: [ids.A1, ids.A2] } },
      orderBy: { periodMonth: 'asc' },
    });
    const pdfs = [...files.keys()].filter((n) => n.startsWith('faktury/'));
    expect(pdfs).toHaveLength(2);
    expect(pdfs.map((n) => sha(files.get(n)!)).sort()).toEqual(
      stored.map((s) => s.pdfSha256).sort(),
    );
    const manifest = files.get('manifest.csv')!.toString('utf8');
    expect(manifest.startsWith('﻿cislo;druh;vystaveno')).toBe(true);
    const rows = manifest.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.split(';')[0]).sort()).toEqual(stored.map((s) => s.number).sort());
    expect(rows.find((r) => r.includes('2026-09'))!.split(';')[11]).toContain(', '); // two hotels
    expect(files.get('README.txt')!.toString('utf8')).toContain('TESTOVACÍ faktury');
  });

  it('a grant on H1 alone never gets the summary; another payer’s invoices never appear', async () => {
    const session = await account([{ payer: payers.A, hotels: [h.H1] }]);
    const files = unzip((await pkg('?from=2026-01&to=2026-12', session).expect(200)).body);
    const stored = await f.prisma.invoice.findUniqueOrThrow({ where: { id: ids.A1 } });
    const pdfs = [...files.keys()].filter((n) => n.startsWith('faktury/'));
    expect(pdfs.map((n) => sha(files.get(n)!))).toEqual([stored.pdfSha256]);
    const other = await account([{ payer: payers.B, hotels: [h.H3] }]);
    const theirs = unzip((await pkg('?from=2026-09&to=2026-09', other).expect(200)).body);
    const b1 = await f.prisma.invoice.findUniqueOrThrow({ where: { id: ids.B1 } });
    expect([...theirs.keys()].filter((n) => n.startsWith('faktury/'))).toEqual([
      `faktury/${b1.number.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`,
    ]);
  });

  it('bounds: the period (order, 12 months), the number of invoices; empty and no session', async () => {
    const session = await account([{ payer: payers.A, hotels: [h.H1, h.H2] }]);
    for (const q of [
      '?from=2026-10&to=2026-08',
      '?from=2025-01&to=2026-01',
      '?from=2026-13&to=2026-12',
      '?from=2026-08',
    ])
      expect((await pkg(q, session)).status, q).toBe(400);
    expect((await pkg('?from=2025-02&to=2026-01', session)).status).not.toBe(400); // 12 months
    const none = await pkg('?from=2025-01&to=2025-03', session);
    expect([none.status, json(none.body).code]).toEqual([404, 'NO_INVOICES']);
    const nobody = await account([]);
    expect((await pkg('?from=2026-08&to=2026-10', nobody)).status).toBe(404);
    expect((await pkg('?from=2026-08&to=2026-10')).status).toBe(401);
    expect((await pkg('?from=2026-08&to=2026-10', session, 'x'.repeat(43))).status).toBe(401);
  });

  it('more invoices than the limit: PACKAGE_TOO_LARGE, nothing sent', async () => {
    const both = await account([
      { payer: payers.A, hotels: [h.H1, h.H2] },
      { payer: payers.B, hotels: [h.H3] },
    ]);
    const res = await pkg('?from=2026-08&to=2026-10', both);
    expect([res.status, json(res.body).code]).toEqual([422, 'PACKAGE_TOO_LARGE']);
  });

  describe('review 5845096918: one ceiling with portal-web', () => {
    const env = () => f.app.get<FinanceEnv>(FINANCE_ENV);

    it('the shared ceiling bounds Finance’s settings: never above what portal-web passes', () => {
      const field = (k: 'FINANCE_PORTAL_PACKAGE_MAX_BYTES' | 'FINANCE_PORTAL_PACKAGE_TIMEOUT_MS') =>
        financeEnvSchema.shape[k];
      expect(
        field('FINANCE_PORTAL_PACKAGE_MAX_BYTES').safeParse(String(PORTAL_PACKAGE_MAX_ZIP_BYTES))
          .success,
      ).toBe(true);
      expect(
        field('FINANCE_PORTAL_PACKAGE_MAX_BYTES').safeParse(
          String(PORTAL_PACKAGE_MAX_ZIP_BYTES + 1),
        ).success,
      ).toBe(false);
      expect(
        field('FINANCE_PORTAL_PACKAGE_TIMEOUT_MS').safeParse(String(PORTAL_PACKAGE_MAX_MS)).success,
      ).toBe(true);
      expect(
        field('FINANCE_PORTAL_PACKAGE_TIMEOUT_MS').safeParse(String(PORTAL_PACKAGE_MAX_MS + 1))
          .success,
      ).toBe(false);
    });

    it('the finished ZIP (headers, manifest, README) exactly at the limit is sent; one byte over is refused before sending', async () => {
      const session = await account([{ payer: payers.A, hotels: [h.H1, h.H2] }]);
      const full = await pkg('?from=2026-08&to=2026-09', session).expect(200);
      const size = (full.body as Buffer).length;
      const pdfBytes = [...unzip(full.body as Buffer).entries()]
        .filter(([n]) => n.startsWith('faktury/'))
        .reduce((sum, [, b]) => sum + b.length, 0);
      expect(size).toBeGreaterThan(pdfBytes); // the overhead is real
      const before = env().FINANCE_PORTAL_PACKAGE_MAX_BYTES;
      try {
        env().FINANCE_PORTAL_PACKAGE_MAX_BYTES = size;
        const at = await pkg('?from=2026-08&to=2026-09', session);
        expect([at.status, (at.body as Buffer).length]).toEqual([200, size]);
        env().FINANCE_PORTAL_PACKAGE_MAX_BYTES = size - 1; // the PDFs alone still fit
        const over = await pkg('?from=2026-08&to=2026-09', session);
        expect(over.status).toBe(422);
        expect(over.headers['content-type']).toMatch(/json/);
        expect(json(over.body).code).toBe('PACKAGE_TOO_LARGE');
      } finally {
        env().FINANCE_PORTAL_PACKAGE_MAX_BYTES = before;
      }
    });
  });
});
