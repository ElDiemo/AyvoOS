import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

/**
 * Finance — received documents (doc 039, N1) through HTTP and the real database: receiving the
 * original (validated by content), idempotency, duplicates, list/detail/download, corrections
 * with history, voiding, database invariants and permissions. Synthetic data only.
 */
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const FD = /^FD-\d{6}$/;

describe.skipIf(!hasDatabase)('finance received documents', () => {
  let t: TestApp;
  let supplierId: string;
  const http = () => request(t.app.getHttpServer());
  const receive = (fields: Record<string, string>, file: Buffer, name = 'faktura.pdf') => {
    let r = http().post('/api/admin/finance/documents').set('Origin', TEST_APP_ORIGIN);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, name);
  };
  const base = () => ({
    requestId: randomUUID(),
    supplierId,
    kind: 'INVOICE',
    documentNumber: `FV-${randomUUID().slice(0, 8)}`,
    issuedOn: '2026-10-01',
  });

  beforeAll(async () => {
    t = await createTestApp();
    const supplier = await http()
      .post('/api/admin/suppliers')
      .set('Origin', TEST_APP_ORIGIN)
      .send({
        requestId: randomUUID(),
        name: `Pronajímatel ${randomUUID().slice(0, 6)}`,
        companyId: null,
        vatId: null,
      })
      .expect(201);
    supplierId = supplier.body.id;
  });
  afterAll(() => t?.close());

  it('receives the original with its metadata, history and an exact download', async () => {
    const file = pdf(`nájem ${randomUUID()}`);
    const res = await receive(
      {
        ...base(),
        documentNumber: '2026-0042',
        taxPointOn: '2026-10-01',
        dueOn: '2026-10-15',
        totalAmount: '25000.00',
        currency: 'CZK',
        description: 'Nájem skladu – říjen',
      },
      file,
      'Nájem říjen.pdf',
    ).expect(201);
    const doc = res.body;
    expect(doc.code).toMatch(FD);
    expect(doc).toMatchObject({
      kind: 'INVOICE',
      documentNumber: '2026-0042',
      issuedOn: '2026-10-01',
      taxPointOn: '2026-10-01',
      dueOn: '2026-10-15',
      totalAmount: '25000.00',
      currency: 'CZK',
      description: 'Nájem skladu – říjen',
      status: 'ACTIVE',
      version: 1,
      contentType: 'application/pdf',
      byteSize: file.length,
      createdBy: 'Test superuser',
      supplier: { id: supplierId },
    });
    expect(doc.originalFilename).toBe('N_jem _jen.pdf');
    expect(doc.history).toEqual([
      expect.objectContaining({ version: 1, type: 'RECEIVED', reason: null, changes: {} }),
    ]);
    const content = await http()
      .get(`/api/admin/finance/documents/${doc.code}/content`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(content.body as Buffer, file)).toBe(0);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['content-disposition']).toMatch(/^attachment; filename="FD-\d{6}-/);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['cache-control']).toBe('private, no-store');
  });

  it('is idempotent per request id; the same file is received once; only PDF/JPEG/PNG', async () => {
    const fields = base();
    const file = pdf(randomUUID());
    const first = await receive(fields, file).expect(201);
    const again = await receive(fields, file).expect(201);
    expect(again.body.code).toBe(first.body.code);
    // The same request id with another file: a conflict, nothing new.
    expect((await receive(fields, pdf(randomUUID())).expect(409)).body.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    // The same file again under a new request: refused, naming the existing document.
    const dup = await receive(base(), file).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_DOCUMENT');
    expect(dup.body.message).toContain(first.body.code);
    // Not a document by content (the name and declared type do not matter).
    const text = await receive(base(), Buffer.from('<html>not a pdf</html>'), 'x.pdf').expect(422);
    expect(text.body.code).toBe('UNSUPPORTED_DOCUMENT');
    await receive(base(), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'scan.jpg').expect(201);
    // Empty optional form fields mean "not given".
    const empty = await receive(
      { ...base(), taxPointOn: '', dueOn: '', totalAmount: '', currency: '', description: '' },
      pdf(randomUUID()),
    ).expect(201);
    expect(empty.body).toMatchObject({
      taxPointOn: null,
      dueOn: null,
      totalAmount: null,
      currency: null,
      description: null,
    });
    // Without a file, with an amount but no currency, with a bad date: refused.
    await http()
      .post('/api/admin/finance/documents')
      .set('Origin', TEST_APP_ORIGIN)
      .field('requestId', randomUUID())
      .expect(400);
    await receive({ ...base(), totalAmount: '10.00' }, pdf(randomUUID())).expect(400);
    await receive({ ...base(), totalAmount: '10.001', currency: 'CZK' }, pdf(randomUUID())).expect(
      400,
    );
    await receive({ ...base(), issuedOn: '2026-13-01' }, pdf(randomUUID())).expect(400);
  });

  it('refuses an unknown or archived supplier', async () => {
    await receive({ ...base(), supplierId: randomUUID() }, pdf(randomUUID())).expect(422);
    const archived = await http()
      .post('/api/admin/suppliers')
      .set('Origin', TEST_APP_ORIGIN)
      .send({
        requestId: randomUUID(),
        name: `Archiv ${randomUUID().slice(0, 6)}`,
        companyId: null,
        vatId: null,
      })
      .expect(201);
    await http()
      .post(`/api/admin/suppliers/${archived.body.id}/archive`)
      .set('Origin', TEST_APP_ORIGIN)
      .send({ requestId: randomUUID() })
      .expect(200);
    const res = await receive({ ...base(), supplierId: archived.body.id }, pdf(randomUUID()));
    expect([res.status, res.body.code]).toEqual([422, 'SUPPLIER_INACTIVE']);
  });

  it('corrects metadata as a new version with the reason; stale and empty corrections are refused', async () => {
    const doc = (
      await receive(
        { ...base(), totalAmount: '100.00', currency: 'CZK' },
        pdf(randomUUID()),
      ).expect(201)
    ).body;
    const fields = {
      supplierId,
      kind: 'INVOICE',
      documentNumber: doc.documentNumber,
      issuedOn: doc.issuedOn,
      totalAmount: '121.00',
      currency: 'CZK',
    };
    const correct = (body: object) =>
      http()
        .post(`/api/admin/finance/documents/${doc.code}/correct`)
        .set('Origin', TEST_APP_ORIGIN)
        .send(body);
    await correct({ ...fields, expectedVersion: 1 }).expect(400); // the reason is required
    const done = await correct({ ...fields, expectedVersion: 1, reason: 'Částka vč. DPH' }).expect(
      200,
    );
    expect(done.body).toMatchObject({ version: 2, totalAmount: '121.00' });
    expect(done.body.history.at(-1)).toMatchObject({
      version: 2,
      type: 'CORRECTED',
      reason: 'Částka vč. DPH',
      changes: { totalAmount: ['100.00', '121.00'] },
    });
    expect(
      (await correct({ ...fields, expectedVersion: 1, reason: 'znovu stará verze' }).expect(409))
        .body.code,
    ).toBe('STALE_VERSION');
    expect(
      (await correct({ ...fields, expectedVersion: 2, reason: 'beze změny' }).expect(422)).body
        .code,
    ).toBe('NOTHING_CHANGED');
    // The file never changes.
    const row = await t.prisma.financeDocument.findUniqueOrThrow({ where: { code: doc.code } });
    expect(row.sha256).toBe(doc.sha256);
  });

  it('voids a document: it stays with its history, cannot change, and its file may be received again', async () => {
    const file = pdf(randomUUID());
    const doc = (await receive(base(), file).expect(201)).body;
    const voided = await http()
      .post(`/api/admin/finance/documents/${doc.code}/void`)
      .set('Origin', TEST_APP_ORIGIN)
      .send({ expectedVersion: 1, reason: 'Nahráno omylem' })
      .expect(200);
    expect(voided.body).toMatchObject({ status: 'VOIDED', version: 2 });
    expect(voided.body.history.map((e: { type: string }) => e.type)).toEqual([
      'RECEIVED',
      'VOIDED',
    ]);
    const again = await http()
      .post(`/api/admin/finance/documents/${doc.code}/void`)
      .set('Origin', TEST_APP_ORIGIN)
      .send({ expectedVersion: 2, reason: 'podruhé' })
      .expect(409);
    expect(again.body.code).toBe('DOCUMENT_VOIDED');
    await receive(base(), file).expect(201);
    await http().get(`/api/admin/finance/documents/${doc.code}/content`).expect(200);
  });

  it('lists with search, supplier, status and issue-date filters, newest first', async () => {
    const number = `HLEDEJ-${randomUUID().slice(0, 6)}`;
    const a = (
      await receive(
        { ...base(), documentNumber: number, issuedOn: '2025-03-10' },
        pdf(randomUUID()),
      ).expect(201)
    ).body;
    const list = (q: Record<string, string>) =>
      http()
        .get('/api/admin/finance/documents')
        .query(q)
        .expect(200)
        .then((r) => r.body);
    expect((await list({ q: number })).items.map((d: { code: string }) => d.code)).toEqual([
      a.code,
    ]);
    expect((await list({ q: a.code.toLowerCase() })).total).toBe(1);
    const march = await list({ issuedFrom: '2025-03-01', issuedTo: '2025-03-31' });
    expect(march.items.map((d: { code: string }) => d.code)).toContain(a.code);
    expect(march.items.every((d: { issuedOn: string }) => d.issuedOn.startsWith('2025-03'))).toBe(
      true,
    );
    const voided = await list({ status: 'VOIDED' });
    expect(voided.items.every((d: { status: string }) => d.status === 'VOIDED')).toBe(true);
    const bySupplier = await list({ supplierId });
    expect(bySupplier.total).toBeGreaterThan(1);
    await http().get('/api/admin/finance/documents').query({ issuedFrom: 'yesterday' }).expect(400);
    await http().get('/api/admin/finance/documents/FD-999999').expect(404);
    await http().get('/api/admin/finance/documents/not-a-code').expect(400);
  });

  it('database invariants: immutable file and identity, versioned changes with events, no deletion', async () => {
    const doc = (await receive(base(), pdf(randomUUID())).expect(201)).body;
    const raw = (sql: string) => t.prisma.$executeRawUnsafe(sql);
    await expect(
      raw(`UPDATE finance_documents SET storage_key = 'x' WHERE code = '${doc.code}'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      raw(`UPDATE finance_documents SET description = 'x' WHERE code = '${doc.code}'`),
    ).rejects.toThrow(/next version/);
    await expect(raw(`DELETE FROM finance_documents WHERE code = '${doc.code}'`)).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      raw(`UPDATE finance_document_events SET reason = 'x' WHERE document_id = '${doc.id}'`),
    ).rejects.toThrow();
    await expect(
      raw(`DELETE FROM finance_document_events WHERE document_id = '${doc.id}'`),
    ).rejects.toThrow();
    // A new version without its event fails at commit.
    await expect(
      raw(
        `UPDATE finance_documents SET description = 'x', version = version + 1 WHERE code = '${doc.code}'`,
      ),
    ).rejects.toThrow(/has no event/);
    await expect(
      raw(`UPDATE finance_documents SET total_amount = 1 WHERE code = '${doc.code}'`),
    ).rejects.toThrow();
  });

  it('ADMIN holds both permissions; a user without them gets 403 on every route', async () => {
    const grants = await t.prisma.rolePermission.findMany({
      where: { permissionCode: { startsWith: 'finance:' } },
      select: { roleCode: true, permissionCode: true },
      orderBy: { permissionCode: 'asc' },
    });
    expect(grants).toEqual([
      { roleCode: 'ADMIN', permissionCode: 'finance:documents_manage' },
      { roleCode: 'ADMIN', permissionCode: 'finance:documents_read' },
    ]);
    const real = await createTestApp({}, {}, { auth: 'real' });
    try {
      const doc = (await receive(base(), pdf(randomUUID())).expect(201)).body;
      const user = await prepareInvitedUser(real, {
        email: `fin-${randomUUID()}@ayvo.test`,
        displayName: 'Bez financí',
      });
      await real.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test: no finance permission' },
      });
      const cookie = await sessionCookie(real, user.email);
      const h = () => request(real.app.getHttpServer());
      for (const path of [
        '/api/admin/finance/documents',
        `/api/admin/finance/documents/${doc.code}`,
        `/api/admin/finance/documents/${doc.code}/content`,
        '/api/admin/finance/suppliers',
      ]) {
        expect([path, (await h().get(path).set('Cookie', cookie)).status]).toEqual([path, 403]);
      }
      const post = await h()
        .post(`/api/admin/finance/documents/${doc.code}/void`)
        .set('Cookie', cookie)
        .set('Origin', TEST_APP_ORIGIN)
        .send({ expectedVersion: 1, reason: 'neoprávněně' });
      expect(post.status).toBe(403);
      await h().get('/api/admin/finance/documents').expect(401);
    } finally {
      await real.close();
    }
  });
});
