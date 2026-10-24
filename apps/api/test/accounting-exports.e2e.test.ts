import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

/**
 * Finance — the export for the accountant (doc 039 §7, N2): preview, a FULL export as a real ZIP
 * (read by Python's zipfile, CRC checked), the history per document version, documents added,
 * corrected and voided after the export, a SUPPLEMENT export of exactly those, idempotency,
 * period rules, append-only records and permissions. Its own period (2012-05) in the shared DB.
 */
const FROM = '2012-05-01';
const TO = '2012-05-31';
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

describe.skipIf(!hasDatabase)('finance accountant export', () => {
  let t: TestApp;
  let supplierId: string;
  const http = () => request(t.app.getHttpServer());
  const post = (path: string) =>
    http().post(`/api/admin/finance/${path}`).set('Origin', TEST_APP_ORIGIN);
  const receive = (issuedOn: string, body: Buffer, extra: Record<string, string> = {}) => {
    let r = post('documents');
    const fields = {
      requestId: randomUUID(),
      supplierId,
      kind: 'INVOICE',
      documentNumber: `EXP-${randomUUID().slice(0, 6)}`,
      issuedOn,
      ...extra,
    };
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r
      .attach('file', body, 'Doklad účetní.pdf')
      .expect(201)
      .then((x) => x.body);
  };
  const zipOf = (code: string) =>
    http()
      .get(`/api/admin/finance/exports/${code}/content`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
  const exportOf = (mode: 'FULL' | 'SUPPLEMENT', requestId = randomUUID()) =>
    post('exports').send({ requestId, periodFrom: FROM, periodTo: TO, mode });

  beforeAll(async () => {
    t = await createTestApp();
    const supplier = await http()
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
  afterAll(() => t?.close());

  it('preview, FULL export as a real ZIP, history; then later changes and a SUPPLEMENT of exactly those', async () => {
    const aFile = pdf(`a ${randomUUID()}`);
    const a = await receive('2012-05-03', aFile, {
      totalAmount: '1000.00',
      currency: 'CZK',
      description: '=SUM(A1)',
    });
    const b = await receive('2012-05-20', pdf(`b ${randomUUID()}`));
    await receive('2012-06-01', pdf(`out ${randomUUID()}`)); // outside the period

    // Preview writes nothing.
    const before = await t.prisma.accountingExport.count();
    const preview = await http()
      .get('/api/admin/finance/exports/preview')
      .query({ periodFrom: FROM, periodTo: TO, mode: 'FULL' })
      .expect(200);
    expect(
      preview.body.lines.map((l: { code: string; change: string }) => [l.code, l.change]),
    ).toEqual([
      [a.code, 'NEW'],
      [b.code, 'NEW'],
    ]);
    expect(preview.body.tooLarge).toBe(false);
    expect(await t.prisma.accountingExport.count()).toBe(before);

    const full = (await exportOf('FULL').expect(201)).body;
    expect(full).toMatchObject({ mode: 'FULL', documentCount: 2, periodFrom: FROM, periodTo: TO });
    expect(full.code).toMatch(/^AE-\d{6}$/);
    expect(full.laterChanges).toEqual([]);
    const zip = readZip((await zipOf(full.code)).body as Buffer);
    expect(zip.names).toEqual([
      'manifest.csv',
      'README.txt',
      `doklady/${a.code}-Doklad _etn_.pdf`,
      `doklady/${b.code}-Doklad _etn_.pdf`,
    ]);
    expect(zip.files[`doklady/${a.code}-Doklad _etn_.pdf`]).toBe(aFile.toString('latin1'));
    expect(zip.manifest[0]).toEqual([
      'kod',
      'zmena',
      'stav',
      'dodavatel',
      'ico_dodavatele',
      'dic_dodavatele',
      'druh',
      'cislo_dokladu',
      'datum_vystaveni',
      'duzp',
      'splatnost',
      'castka',
      'mena',
      'popis',
      'soubor',
      'sha256',
      'verze',
    ]);
    const rowA = zip.manifest.find((r) => r[0] === a.code)!;
    expect(rowA.slice(0, 2)).toEqual([a.code, 'NEW']);
    expect(rowA.slice(4, 6)).toEqual(['12345678', 'CZ12345678']);
    expect(rowA[11]).toBe('1000.00');
    expect(rowA[13]).toBe("'=SUM(A1)"); // CSV formula injection neutralised
    expect(rowA[15]).toBe(a.sha256);

    // After the export: a new document, a correction and a voiding in the period.
    const c = await receive('2012-05-25', pdf(`c ${randomUUID()}`));
    await post(`documents/${a.code}/correct`)
      .send({
        supplierId,
        kind: 'INVOICE',
        documentNumber: a.documentNumber,
        issuedOn: '2012-05-03',
        totalAmount: '1210.00',
        currency: 'CZK',
        description: 'opraveno',
        expectedVersion: 1,
        reason: 'Částka s DPH',
      })
      .expect(200);
    await post(`documents/${b.code}/void`)
      .send({ expectedVersion: 1, reason: 'Duplicitní doklad' })
      .expect(200);
    const after = (await http().get(`/api/admin/finance/exports/${full.code}`).expect(200)).body;
    // The export itself stays as handed over (versions and amounts of that moment)…
    expect(after.lines.find((l: { code: string }) => l.code === a.code)).toMatchObject({
      version: 1,
      totalAmount: '1000.00',
    });
    // …and shows what changed later.
    expect(
      after.laterChanges.map((l: { code: string; change: string }) => [l.code, l.change]),
    ).toEqual([
      [a.code, 'CHANGED'],
      [b.code, 'VOIDED'],
      [c.code, 'NEW'],
    ]);

    const supplement = (await exportOf('SUPPLEMENT').expect(201)).body;
    expect(supplement.documentCount).toBe(3);
    const sZip = readZip((await zipOf(supplement.code)).body as Buffer);
    expect(sZip.names.filter((n) => n.startsWith('doklady/')).sort()).toEqual(
      [`doklady/${a.code}-Doklad _etn_.pdf`, `doklady/${c.code}-Doklad _etn_.pdf`].sort(),
    );
    const changes = Object.fromEntries(
      sZip.manifest.slice(1).map((r) => [r[0], [r[1], r[2], r[14]]]),
    );
    expect(changes).toEqual({
      [a.code]: ['CHANGED', 'ACTIVE', `doklady/${a.code}-Doklad _etn_.pdf`],
      [b.code]: ['VOIDED', 'VOIDED', ''],
      [c.code]: ['NEW', 'ACTIVE', `doklady/${c.code}-Doklad _etn_.pdf`],
    });
    // Nothing left to hand over; a further supplement is refused.
    expect((await http().get(`/api/admin/finance/exports/${full.code}`)).body.laterChanges).toEqual(
      [],
    );
    expect((await exportOf('SUPPLEMENT').expect(422)).body.code).toBe('NOTHING_TO_EXPORT');
    // A FULL export again: everything valid, marked as already handed over.
    const again = (await exportOf('FULL').expect(201)).body;
    expect(again.lines.map((l: { code: string; change: string }) => [l.code, l.change])).toEqual([
      [a.code, 'INCLUDED'],
      [c.code, 'INCLUDED'],
    ]);
    const list = (await http().get('/api/admin/finance/exports').expect(200)).body;
    expect(list.slice(0, 3).map((e: { code: string }) => e.code)).toEqual([
      again.code,
      supplement.code,
      full.code,
    ]);
  });

  it('is idempotent per request id; periods are validated; records are append-only', async () => {
    await receive('2012-05-10', pdf(`i ${randomUUID()}`));
    const requestId = randomUUID();
    const first = (await exportOf('SUPPLEMENT', requestId).expect(201)).body;
    const again = (await exportOf('SUPPLEMENT', requestId).expect(201)).body;
    expect(again.code).toBe(first.code);
    expect((await exportOf('FULL', requestId).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
    await post('exports')
      .send({ requestId: randomUUID(), periodFrom: TO, periodTo: FROM, mode: 'FULL' })
      .expect(400);
    await post('exports')
      .send({
        requestId: randomUUID(),
        periodFrom: '2012-01-01',
        periodTo: '2013-02-01',
        mode: 'FULL',
      })
      .expect(400);
    await http()
      .get('/api/admin/finance/exports/preview')
      .query({ periodFrom: FROM, periodTo: TO, mode: 'ALL' })
      .expect(400);
    await http().get('/api/admin/finance/exports/AE-999999').expect(404);
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE accounting_exports SET note = 'x' WHERE code = '${first.code}'`,
      ),
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM accounting_export_items`),
    ).rejects.toThrow();
  });

  it('only ADMIN may create exports; reading needs finance:documents_read', async () => {
    const grants = await t.prisma.rolePermission.findMany({
      where: { permissionCode: 'finance:exports_manage' },
      select: { roleCode: true },
    });
    expect(grants).toEqual([{ roleCode: 'ADMIN' }]);
    const real = await createTestApp({}, {}, { auth: 'real' });
    try {
      const user = await prepareInvitedUser(real, {
        email: `exp-${randomUUID()}@ayvo.test`,
        displayName: 'Bez exportu',
      });
      await real.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test' },
      });
      const cookie = await sessionCookie(real, user.email);
      const h = () => request(real.app.getHttpServer());
      expect((await h().get('/api/admin/finance/exports').set('Cookie', cookie)).status).toBe(403);
      expect(
        (
          await h()
            .get('/api/admin/finance/exports/preview')
            .query({ periodFrom: FROM, periodTo: TO, mode: 'FULL' })
            .set('Cookie', cookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await h()
            .post('/api/admin/finance/exports')
            .set('Cookie', cookie)
            .set('Origin', TEST_APP_ORIGIN)
            .send({ requestId: randomUUID(), periodFrom: FROM, periodTo: TO, mode: 'FULL' })
        ).status,
      ).toBe(403);
    } finally {
      await real.close();
    }
  });
});
