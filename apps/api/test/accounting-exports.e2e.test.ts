import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_LIMITS } from '../src/finance/accounting-exports.service.js';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { hasDatabase, TEST_APP_ORIGIN } from './support/test-app.js';

/**
 * Finance — the monthly export for the accountant (doc 039 §7, N2) in the Finance unit: preview
 * with its fingerprint, the confirmation bound to it (review F-R2), a real ZIP read by Python's
 * zipfile, the handover month (F-R3), bounds before loading files (F-R4), idempotency over the
 * complete request and concurrent requests (F-R5), later changes relative to each export (F-R6),
 * downloads and the manual "Předáno účetní" as separate events, append-only records, permissions.
 */
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

interface ZipContent {
  names: string[];
  manifest: string[][];
  files: Record<string, string>;
}
function readZip(zip: Buffer): ZipContent {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-export-'));
  const file = join(dir, 'e.zip');
  writeFileSync(file, zip);
  const res = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import json, sys, zipfile',
        'z = zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None',
        'names = z.namelist()',
        'm = z.read("manifest.csv").decode("utf-8-sig")',
        'files = {n: z.read(n).decode("latin-1") for n in names if n.startswith("doklady/")}',
        'print(json.dumps({"names": names, "manifest": [l.split(";") for l in m.split("\\r\\n") if l], "files": files}))',
      ].join('\n'),
      file,
    ],
    { encoding: 'utf8' },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

type Line = { code: string; change: string };
const pairs = (lines: Line[]) => lines.map((l) => [l.code, l.change]);

describe.skipIf(!hasDatabase)('finance accountant export (Finance unit)', () => {
  let f: FinanceTestApp;
  let supplierId: string;
  const receive = (
    handoverMonth: string | null,
    body: Buffer,
    extra: Record<string, string> = {},
  ) => {
    let r = f.post('/api/admin/finance/documents');
    const fields: Record<string, string> = {
      requestId: randomUUID(),
      supplierId,
      kind: 'INVOICE',
      documentNumber: `EXP-${randomUUID().slice(0, 6)}`,
      issuedOn: `${handoverMonth ?? '2012-01'}-10`,
      ...(handoverMonth ? { handoverMonth } : {}),
      ...extra,
    };
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r
      .attach('file', body, 'Doklad účetní.pdf')
      .expect(201)
      .then((x) => x.body);
  };
  const preview = (handoverMonth: string, mode: 'FULL' | 'SUPPLEMENT') =>
    f
      .get('/api/admin/finance/exports/preview')
      .query({ handoverMonth, mode })
      .expect(200)
      .then((r) => r.body);
  /** Preview, then confirm exactly that preview; expects the given status. */
  const exportOf = async (
    handoverMonth: string,
    mode: 'FULL' | 'SUPPLEMENT',
    status: number,
    requestId = randomUUID(),
  ) => {
    const p = await preview(handoverMonth, mode);
    return f
      .post('/api/admin/finance/exports')
      .send({ requestId, handoverMonth, mode, previewFingerprint: p.fingerprint })
      .expect(status);
  };
  const zipOf = (code: string) =>
    f
      .get(`/api/admin/finance/exports/${code}/content`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
  const correct = (
    doc: { code: string; documentNumber: string; issuedOn: string },
    version: number,
    extra: object,
  ) =>
    f.post(`/api/admin/finance/documents/${doc.code}/correct`).send({
      supplierId,
      kind: 'INVOICE',
      documentNumber: doc.documentNumber,
      issuedOn: doc.issuedOn,
      expectedVersion: version,
      reason: 'oprava',
      ...extra,
    });

  beforeAll(async () => {
    f = await createFinanceTestApp();
    const supplier = await request(f.core.app.getHttpServer())
      .post('/api/admin/suppliers')
      .set('Origin', TEST_APP_ORIGIN)
      .send({
        requestId: randomUUID(),
        name: `Účetní ${randomUUID().slice(0, 6)}`,
        companyId: '12345678',
        vatId: 'CZ12345678',
      })
      .expect(201);
    supplierId = supplier.body.id;
  });
  afterAll(() => f?.close());

  it('by handover month: preview, FULL as a real ZIP, later changes, SUPPLEMENT of exactly those', async () => {
    const M = '2012-05';
    const aFile = pdf(`a ${randomUUID()}`);
    // Issued in April, handed over with May (the month is the person's choice, not the date).
    const a = await receive(M, aFile, {
      issuedOn: '2012-04-28',
      totalAmount: '1000.00',
      currency: 'CZK',
      description: '=SUM(A1)',
    });
    const b = await receive(M, pdf(`b ${randomUUID()}`), { totalAmount: '5.50', currency: 'EUR' });
    await receive('2012-06', pdf(`out ${randomUUID()}`)); // another month
    await receive(null, pdf(`none ${randomUUID()}`)); // no month yet

    const before = await f.prisma.export.count();
    const p = await preview(M, 'FULL');
    expect(pairs(p.lines)).toEqual([
      [a.code, 'NEW'],
      [b.code, 'NEW'],
    ]);
    expect(p.totals).toEqual([
      { currency: 'CZK', amount: '1000.00' },
      { currency: 'EUR', amount: '5.50' },
    ]);
    expect(p.unassigned).toBeGreaterThan(0);
    expect(p.incomplete).toEqual([]);
    expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.prisma.export.count()).toBe(before); // a preview writes nothing

    const full = (await exportOf(M, 'FULL', 201)).body;
    expect(full).toMatchObject({
      mode: 'FULL',
      documentCount: 2,
      handoverMonth: M,
      handedOverOn: null,
    });
    expect(full.events.map((e: { type: string }) => e.type)).toEqual(['GENERATED']);
    const zip = readZip((await zipOf(full.code)).body as Buffer);
    expect(zip.names).toEqual([
      'manifest.csv',
      'README.txt',
      `doklady/${a.code}-Doklad _etn_.pdf`,
      `doklady/${b.code}-Doklad _etn_.pdf`,
    ]);
    expect(zip.files[`doklady/${a.code}-Doklad _etn_.pdf`]).toBe(aFile.toString('latin1'));
    const header = zip.manifest[0]!;
    const col = (name: string) => header.indexOf(name);
    const rowA = zip.manifest.find((r) => r[0] === a.code)!;
    expect(rowA[col('zmena')]).toBe('NEW');
    expect(rowA[col('predavaci_mesic')]).toBe(M);
    expect(rowA[col('ico_dodavatele')]).toBe('12345678');
    expect(rowA[col('castka')]).toBe('1000.00');
    expect(rowA[col('popis')]).toBe("'=SUM(A1)"); // CSV formula injection neutralised
    expect(rowA[col('sha256')]).toBe(a.sha256);
    expect(rowA[col('zdroj')]).toBe('FINANCE');

    // A download is recorded and is not a handover.
    const downloaded = (await f.get(`/api/admin/finance/exports/${full.code}`).expect(200)).body;
    expect(downloaded).toMatchObject({ downloads: 1, handedOverOn: null });

    // After the export: a late document of May, a correction and a voiding.
    const c = await receive(M, pdf(`c ${randomUUID()}`));
    await correct(a, 1, { totalAmount: '1210.00', currency: 'CZK', handoverMonth: M }).expect(200);
    await f
      .post(`/api/admin/finance/documents/${b.code}/void`)
      .send({ expectedVersion: 1, reason: 'Duplicitní doklad' })
      .expect(200);
    const after = (await f.get(`/api/admin/finance/exports/${full.code}`).expect(200)).body;
    expect(after.lines.find((l: { code: string }) => l.code === a.code)).toMatchObject({
      version: 1,
      totalAmount: '1000.00',
    });
    const later = [
      [a.code, 'CHANGED'],
      [b.code, 'VOIDED'],
      [c.code, 'NEW'],
    ];
    expect(pairs(after.laterChanges)).toEqual(later);

    const supplement = (await exportOf(M, 'SUPPLEMENT', 201)).body;
    expect(supplement.documentCount).toBe(3);
    const sZip = readZip((await zipOf(supplement.code)).body as Buffer);
    expect(sZip.names.filter((n) => n.startsWith('doklady/')).sort()).toEqual(
      [`doklady/${a.code}-Doklad _etn_.pdf`, `doklady/${c.code}-Doklad _etn_.pdf`].sort(),
    );
    // F-R6: the FIRST export still shows what changed against IT, after the supplement too.
    const firstAgain = (await f.get(`/api/admin/finance/exports/${full.code}`).expect(200)).body;
    expect(pairs(firstAgain.laterChanges)).toEqual(later);
    const sDetail = (await f.get(`/api/admin/finance/exports/${supplement.code}`)).body;
    expect(sDetail.laterChanges).toEqual([]);
    expect((await exportOf(M, 'SUPPLEMENT', 422)).body.code).toBe('NOTHING_TO_EXPORT');
    const again = (await exportOf(M, 'FULL', 201)).body;
    expect(pairs(again.lines)).toEqual([
      [a.code, 'INCLUDED'],
      [c.code, 'INCLUDED'],
    ]);
  });

  it('F-R2: a change between the preview and the confirmation is refused as stale — metadata, a new document, a voiding', async () => {
    const M = '2012-07';
    const d = await receive(M, pdf(randomUUID()), { totalAmount: '10.00', currency: 'CZK' });
    const confirm = (fingerprint: string) =>
      f.post('/api/admin/finance/exports').send({
        requestId: randomUUID(),
        handoverMonth: M,
        mode: 'FULL',
        previewFingerprint: fingerprint,
      });
    let p = await preview(M, 'FULL');
    await correct(d, 1, { totalAmount: '99.00', currency: 'CZK', handoverMonth: M }).expect(200);
    expect((await confirm(p.fingerprint).expect(409)).body.code).toBe('PREVIEW_STALE');
    p = await preview(M, 'FULL');
    await receive(M, pdf(randomUUID()));
    expect((await confirm(p.fingerprint).expect(409)).body.code).toBe('PREVIEW_STALE');
    p = await preview(M, 'FULL');
    await f
      .post(`/api/admin/finance/documents/${d.code}/void`)
      .send({ expectedVersion: 2, reason: 'zrušeno' })
      .expect(200);
    expect((await confirm(p.fingerprint).expect(409)).body.code).toBe('PREVIEW_STALE');
    p = await preview(M, 'FULL');
    await confirm(p.fingerprint).expect(201); // a fresh preview is accepted
  });

  it('F-R3: incomplete documents of the month block the export until completed', async () => {
    const M = '2012-08';
    const ok = await receive(M, pdf(randomUUID()));
    const draft = (
      await f
        .post('/api/admin/finance/documents')
        .field('requestId', randomUUID())
        .field('kind', 'OTHER')
        .field('handoverMonth', M)
        .attach('file', pdf(randomUUID()), 'k.pdf')
        .expect(201)
    ).body;
    const p = await preview(M, 'FULL');
    expect(p.incomplete).toEqual([
      { code: draft.code, missing: ['supplierId', 'documentNumber', 'issuedOn'] },
    ]);
    expect(p.lines.map((l: { code: string }) => l.code)).toEqual([ok.code]);
    expect((await exportOf(M, 'FULL', 422)).body.code).toBe('INCOMPLETE_DOCUMENTS');
    await f
      .post(`/api/admin/finance/documents/${draft.code}/correct`)
      .send({
        supplierId,
        kind: 'OTHER',
        documentNumber: 'DOPL',
        issuedOn: '2012-08-02',
        handoverMonth: M,
        expectedVersion: 1,
        reason: 'doplněno',
      })
      .expect(200);
    expect((await exportOf(M, 'FULL', 201)).body.documentCount).toBe(2);
    await f
      .get('/api/admin/finance/exports/preview')
      .query({ handoverMonth: '2012-13', mode: 'FULL' })
      .expect(400);
  });

  it('F-R5: idempotent over the complete request; concurrent identical requests give one export; another meanwhile is busy', async () => {
    const M = '2012-09';
    await receive(M, pdf(randomUUID()));
    const p = await preview(M, 'FULL');
    const body = {
      requestId: randomUUID(),
      handoverMonth: M,
      mode: 'FULL',
      previewFingerprint: p.fingerprint,
      note: 'a',
    };
    const send = (b: object) => f.post('/api/admin/finance/exports').send(b);
    const [x, y] = await Promise.all([send(body), send(body)]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.code).toBe(y.body.code);
    expect(await f.prisma.export.count({ where: { requestId: body.requestId } })).toBe(1);
    // A replay (lost answer) returns it; anything else under the id is a conflict.
    expect((await send(body).expect(201)).body.code).toBe(x.body.code);
    for (const other of [
      { note: 'b' },
      { mode: 'SUPPLEMENT' },
      { previewFingerprint: 'f'.repeat(64) },
    ])
      expect((await send({ ...body, ...other }).expect(409)).body.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
    // Two different exports at the same moment: one is built, the other is told to wait.
    await receive('2012-10', pdf(randomUUID()));
    await receive('2012-11', pdf(randomUUID()));
    const [p1, p2] = await Promise.all([preview('2012-10', 'FULL'), preview('2012-11', 'FULL')]);
    const results = await Promise.all([
      send({
        requestId: randomUUID(),
        handoverMonth: '2012-10',
        mode: 'FULL',
        previewFingerprint: p1.fingerprint,
      }),
      send({
        requestId: randomUUID(),
        handoverMonth: '2012-11',
        mode: 'FULL',
        previewFingerprint: p2.fingerprint,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('EXPORT_BUSY');
  });

  it('F-R4: bounds on the declared sizes before any file is loaded; a changed original stops the export', async () => {
    const M = '2013-01';
    await receive(M, pdf(`l ${randomUUID()}`));
    await receive(M, pdf(`m ${randomUUID()}`));
    const saved = { ...EXPORT_LIMITS };
    let reads = 0;
    const get = f.storage.get.bind(f.storage);
    f.storage.get = (key: string) => {
      reads += 1;
      return get(key);
    };
    try {
      EXPORT_LIMITS.documents = 1;
      const p = await preview(M, 'FULL');
      expect(p.tooLarge).toBe(true);
      expect(p.limits.documents).toBe(1);
      expect((await exportOf(M, 'FULL', 422)).body.code).toBe('EXPORT_TOO_LARGE');
      EXPORT_LIMITS.documents = saved.documents;
      EXPORT_LIMITS.bytes = 10; // any original is larger
      expect((await exportOf(M, 'FULL', 422)).body.code).toBe('EXPORT_TOO_LARGE');
      expect(reads).toBe(0); // refused before loading anything
    } finally {
      Object.assign(EXPORT_LIMITS, saved);
      f.storage.get = get;
    }
    const month = new Date(`${M}-01T00:00:00Z`);
    const doc = await f.prisma.document.findFirstOrThrow({ where: { handoverMonth: month } });
    // Changed behind the application's back (put() never overwrites; the file itself is edited).
    chmodSync(join(f.storage.directory, doc.storageKey!), 0o640);
    writeFileSync(join(f.storage.directory, doc.storageKey!), pdf('tampered'));
    const res = await exportOf(M, 'FULL', 500);
    expect([res.status, res.body.code]).toEqual([500, 'STORED_FILE_CHANGED']);
    expect(await f.prisma.export.count({ where: { handoverMonth: month } })).toBe(0);
  });

  it('"Předáno účetní" is a separate, manual, single record; records are append-only', async () => {
    const M = '2013-02';
    await receive(M, pdf(randomUUID()));
    const e = (await exportOf(M, 'FULL', 201)).body;
    const hand = (requestId: string, handedOverOn = '2013-03-05') =>
      f
        .post(`/api/admin/finance/exports/${e.code}/handover`)
        .send({ requestId, handedOverOn, note: 'e-mailem UOL' });
    const requestId = randomUUID();
    const done = (await hand(requestId).expect(200)).body;
    expect(done.handedOverOn).toBe('2013-03-05');
    expect(done.events.map((x: { type: string }) => x.type)).toEqual(['GENERATED', 'HANDED_OVER']);
    expect((await hand(requestId).expect(200)).body.handedOverOn).toBe('2013-03-05'); // replay
    expect((await hand(requestId, '2013-03-06').expect(409)).body.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    expect((await hand(randomUUID()).expect(409)).body.code).toBe('ALREADY_HANDED_OVER');
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    try {
      for (const sql of [
        `UPDATE finance.exports SET note = 'x' WHERE code = '${e.code}'`,
        'DELETE FROM finance.export_items',
        'DELETE FROM finance.export_events',
      ])
        await expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.$disconnect();
    }
  });

  it('only ADMIN may create and hand over exports; others are refused, also on the download', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const grants = await real.core.prisma.rolePermission.findMany({
        where: { permissionCode: 'finance:exports_manage' },
        select: { roleCode: true },
      });
      expect(grants).toEqual([{ roleCode: 'ADMIN' }]);
      const user = await prepareInvitedUser(real.core, {
        email: `exp-${randomUUID()}@ayvo.test`,
        displayName: 'Bez exportu',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      const someExport = await f.prisma.export.findFirstOrThrow();
      for (const path of [
        '/api/admin/finance/exports',
        '/api/admin/finance/exports/preview?handoverMonth=2012-05&mode=FULL',
        `/api/admin/finance/exports/${someExport.code}`,
        `/api/admin/finance/exports/${someExport.code}/content`,
      ])
        expect([path, (await real.get(path, cookie)).status]).toEqual([path, 403]);
      const writes: [string, object][] = [
        [
          '/api/admin/finance/exports',
          {
            requestId: randomUUID(),
            handoverMonth: '2012-05',
            mode: 'FULL',
            previewFingerprint: 'a'.repeat(64),
          },
        ],
        [
          `/api/admin/finance/exports/${someExport.code}/handover`,
          { requestId: randomUUID(), handedOverOn: '2013-01-01' },
        ],
      ];
      for (const [path, body] of writes)
        expect([path, (await real.post(path, cookie).send(body)).status]).toEqual([path, 403]);
    } finally {
      await real.close();
    }
  });
});
