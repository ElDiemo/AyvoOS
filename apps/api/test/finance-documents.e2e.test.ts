import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/finance-prisma/client.js';
import {
  createFinanceTestApp,
  TEST_SESSION_COOKIE,
  financeDatabaseUrl,
  financeOwnerDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { prepareInvitedUser, sessionCookie } from './support/sign-in.js';
import { databaseUrl, hasDatabase, TEST_APP_ORIGIN } from './support/test-app.js';

/**
 * Finance — received documents (doc 039, N1) in the Finance unit (ADR 0039): its own Nest app,
 * DB role and schema, talking to a real core over the internal contract. Receiving the PDF
 * original, drafts and the handover month, takeover of a supplier document, idempotency over
 * the original request, corrections with history, voiding, the database roles, the core being
 * down, the contract's service token and CSRF rule, and permissions with real sessions.
 */
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
const FD = /^FD-\d{6}$/;
const bytes = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe.skipIf(!hasDatabase)('finance received documents (Finance unit)', () => {
  let f: FinanceTestApp;
  let supplierId: string;
  let supplierName: string;
  const core = () => request(f.core.app.getHttpServer());
  const receive = (fields: Record<string, string>, file: Buffer, name = 'faktura.pdf') => {
    let r = f.post('/api/admin/finance/documents');
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, name);
  };
  const base = () => ({
    requestId: randomUUID(),
    supplierId,
    kind: 'INVOICE',
    documentNumber: `FV-${randomUUID().slice(0, 8)}`,
    issuedOn: '2026-10-01',
    handoverMonth: '2026-10',
  });
  const newSupplier = async (name: string) =>
    (
      await core()
        .post('/api/admin/suppliers')
        .set('Origin', TEST_APP_ORIGIN)
        .send({ requestId: randomUUID(), name, companyId: null, vatId: null })
        .expect(201)
    ).body as { id: string; name: string };

  beforeAll(async () => {
    f = await createFinanceTestApp();
    const s = await newSupplier(`Pronajímatel ${randomUUID().slice(0, 6)}`);
    supplierId = s.id;
    supplierName = s.name;
  });
  afterAll(() => f?.close());

  it('receives the PDF original with its metadata, history and an exact download', async () => {
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
      handoverMonth: '2026-10',
      missing: [],
      status: 'ACTIVE',
      version: 1,
      source: 'UPLOAD',
      supplierDocument: null,
      contentType: 'application/pdf',
      byteSize: file.length,
      createdBy: 'Test superuser',
      supplier: { id: supplierId, name: supplierName },
    });
    expect(doc.originalFilename).toBe('N_jem _jen.pdf');
    expect(doc.history).toEqual([
      expect.objectContaining({ version: 1, type: 'RECEIVED', reason: null, changes: {} }),
    ]);
    const content = await bytes(f.get(`/api/admin/finance/documents/${doc.code}/content`)).expect(
      200,
    );
    expect(Buffer.compare(content.body as Buffer, file)).toBe(0);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['content-disposition']).toMatch(/^attachment; filename="FD-\d{6}-/);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['cache-control']).toBe('private, no-store');
  });

  it('a draft needs only the file and the kind; it shows what is missing until completed', async () => {
    const draft = (
      await receive({ requestId: randomUUID(), kind: 'OTHER' }, pdf(randomUUID())).expect(201)
    ).body;
    expect(draft).toMatchObject({
      supplier: null,
      documentNumber: null,
      issuedOn: null,
      handoverMonth: null,
      missing: ['supplierId', 'documentNumber', 'issuedOn', 'handoverMonth'],
    });
    const incomplete = await f
      .get('/api/admin/finance/documents')
      .query({ incomplete: 'true' })
      .expect(200);
    expect(incomplete.body.items.map((d: { code: string }) => d.code)).toContain(draft.code);
    const done = await f
      .post(`/api/admin/finance/documents/${draft.code}/correct`)
      .send({
        supplierId,
        kind: 'INVOICE',
        documentNumber: 'DOPL-1',
        issuedOn: '2026-09-28',
        handoverMonth: '2026-09',
        expectedVersion: 1,
        reason: 'Doplněno',
      })
      .expect(200);
    expect(done.body).toMatchObject({ missing: [], handoverMonth: '2026-09', version: 2 });
    const september = await f
      .get('/api/admin/finance/documents')
      .query({ handoverMonth: '2026-09' })
      .expect(200);
    expect(september.body.items.map((d: { code: string }) => d.code)).toContain(draft.code);
    await receive({ ...base(), handoverMonth: '2026-13' }, pdf(randomUUID())).expect(400);
  });

  it('idempotent over the original request: replay → the same document (also after a correction); anything else under the id is a conflict', async () => {
    const fields = base();
    const file = pdf(randomUUID());
    const first = await receive(fields, file).expect(201);
    expect((await receive(fields, file).expect(201)).body.code).toBe(first.body.code);
    // Same id + same file + other metadata (review F-R5): a conflict, not the old success.
    const variants: Record<string, string>[] = [
      { documentNumber: 'JINE-CISLO' },
      { supplierId: (await newSupplier(`Jiný ${randomUUID().slice(0, 6)}`)).id },
      { issuedOn: '2026-10-02' },
      { handoverMonth: '2026-11' },
      { totalAmount: '1.00', currency: 'CZK' },
    ];
    for (const other of variants)
      expect((await receive({ ...fields, ...other }, file).expect(409)).body.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
    expect((await receive(fields, pdf(randomUUID())).expect(409)).body.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    // After a correction the original replay still answers with the same document.
    await f
      .post(`/api/admin/finance/documents/${first.body.code}/correct`)
      .send({
        ...fields,
        requestId: undefined,
        documentNumber: 'OPRAVA',
        expectedVersion: 1,
        reason: 'oprava',
      })
      .expect(200);
    const replay = await receive(fields, file).expect(201);
    expect(replay.body).toMatchObject({ code: first.body.code, documentNumber: 'OPRAVA' });
    // Two concurrent identical requests: one document.
    const both = base();
    const twin = pdf(randomUUID());
    const [a, b] = await Promise.all([receive(both, twin), receive(both, twin)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.code).toBe(b.body.code);
    expect(await f.prisma.document.count({ where: { requestId: both.requestId } })).toBe(1);
  });

  it('the same file is received once; only PDF by content; validation', async () => {
    const file = pdf(randomUUID());
    const first = await receive(base(), file).expect(201);
    const dup = await receive(base(), file).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_DOCUMENT');
    expect(dup.body.message).toContain(first.body.code);
    for (const [content, name] of [
      [Buffer.from('<html>not a pdf</html>'), 'x.pdf'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'scan.jpg'],
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'scan.png'],
    ] as const)
      expect((await receive(base(), content, name).expect(422)).body.code).toBe(
        'UNSUPPORTED_DOCUMENT',
      );
    const empty = await receive(
      { ...base(), taxPointOn: '', dueOn: '', totalAmount: '', currency: '', description: '' },
      pdf(randomUUID()),
    ).expect(201);
    expect(empty.body).toMatchObject({ taxPointOn: null, dueOn: null, totalAmount: null });
    await f.post('/api/admin/finance/documents').field('requestId', randomUUID()).expect(400);
    await receive({ ...base(), totalAmount: '10.00' }, pdf(randomUUID())).expect(400);
    await receive({ ...base(), totalAmount: '10.001', currency: 'CZK' }, pdf(randomUUID())).expect(
      400,
    );
    await receive({ ...base(), issuedOn: '2026-13-01' }, pdf(randomUUID())).expect(400);
  });

  it('refuses an unknown or archived supplier (the core decides)', async () => {
    await receive({ ...base(), supplierId: randomUUID() }, pdf(randomUUID())).expect(422);
    const archived = await newSupplier(`Archiv ${randomUUID().slice(0, 6)}`);
    await core()
      .post(`/api/admin/suppliers/${archived.id}/archive`)
      .set('Origin', TEST_APP_ORIGIN)
      .send({ requestId: randomUUID() })
      .expect(200);
    const res = await receive({ ...base(), supplierId: archived.id }, pdf(randomUUID()));
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
      handoverMonth: doc.handoverMonth,
      totalAmount: '121.00',
      currency: 'CZK',
    };
    const correct = (body: object) =>
      f.post(`/api/admin/finance/documents/${doc.code}/correct`).send(body);
    await correct({ ...fields, expectedVersion: 1 }).expect(400); // the reason is required
    const done = await correct({ ...fields, expectedVersion: 1, reason: 'Částka vč. DPH' }).expect(
      200,
    );
    expect(done.body.history.at(-1)).toMatchObject({
      version: 2,
      type: 'CORRECTED',
      reason: 'Částka vč. DPH',
      changes: { totalAmount: ['100.00', '121.00'] },
    });
    expect(
      (await correct({ ...fields, expectedVersion: 1, reason: 'stará verze' }).expect(409)).body
        .code,
    ).toBe('STALE_VERSION');
    expect(
      (await correct({ ...fields, expectedVersion: 2, reason: 'beze změny' }).expect(422)).body
        .code,
    ).toBe('NOTHING_CHANGED');
    const other = await newSupplier(`Jiný dodavatel ${randomUUID().slice(0, 6)}`);
    const moved = await correct({
      ...fields,
      supplierId: other.id,
      expectedVersion: 2,
      reason: 'Jiný dodavatel',
    }).expect(200);
    expect(moved.body.history.at(-1).changes).toEqual({ supplierId: [supplierName, other.name] });
    const row = await f.prisma.document.findUniqueOrThrow({ where: { code: doc.code } });
    expect(row.sha256).toBe(doc.sha256);
  });

  it('voids a document: it stays with its history, cannot change, and its file may be received again', async () => {
    const file = pdf(randomUUID());
    const doc = (await receive(base(), file).expect(201)).body;
    const voided = await f
      .post(`/api/admin/finance/documents/${doc.code}/void`)
      .send({ expectedVersion: 1, reason: 'Nahráno omylem' })
      .expect(200);
    expect(voided.body).toMatchObject({ status: 'VOIDED', version: 2 });
    const again = await f
      .post(`/api/admin/finance/documents/${doc.code}/void`)
      .send({ expectedVersion: 2, reason: 'podruhé' })
      .expect(409);
    expect(again.body.code).toBe('DOCUMENT_VOIDED');
    await receive(base(), file).expect(201);
    await f.get(`/api/admin/finance/documents/${doc.code}/content`).expect(200);
  });

  it('lists with search, supplier, status, handover month and issue-date filters', async () => {
    const number = `HLEDEJ-${randomUUID().slice(0, 6)}`;
    const a = (
      await receive(
        { ...base(), documentNumber: number, issuedOn: '2025-03-10', handoverMonth: '2025-03' },
        pdf(randomUUID()),
      ).expect(201)
    ).body;
    const list = (q: Record<string, string>) =>
      f
        .get('/api/admin/finance/documents')
        .query(q)
        .expect(200)
        .then((r) => r.body);
    expect((await list({ q: number })).items.map((d: { code: string }) => d.code)).toEqual([
      a.code,
    ]);
    expect((await list({ q: a.code.toLowerCase() })).total).toBe(1);
    expect((await list({ q: supplierName })).total).toBeGreaterThan(0);
    const march = await list({ issuedFrom: '2025-03-01', issuedTo: '2025-03-31' });
    expect(march.items.map((d: { code: string }) => d.code)).toContain(a.code);
    expect(
      (await list({ handoverMonth: '2025-03' })).items.map((d: { code: string }) => d.code),
    ).toEqual([a.code]);
    expect(
      (await list({ status: 'VOIDED' })).items.every(
        (d: { status: string }) => d.status === 'VOIDED',
      ),
    ).toBe(true);
    expect((await list({ supplierId })).total).toBeGreaterThan(1);
    await f.get('/api/admin/finance/documents').query({ issuedFrom: 'yesterday' }).expect(400);
    await f.get('/api/admin/finance/documents/FD-999999').expect(404);
    await f.get('/api/admin/finance/documents/not-a-code').expect(400);
  });

  it('takes over a supplier document of Sklad: no second copy, once, same bytes, replay-safe', async () => {
    const file = pdf(`sklad ${randomUUID()}`);
    const sd = await core()
      .post('/api/admin/supplier-documents')
      .set('Origin', TEST_APP_ORIGIN)
      .field('requestId', randomUUID())
      .field('supplierId', supplierId)
      .field('kind', 'INVOICE')
      .field('documentNumber', `SKL-${randomUUID().slice(0, 6)}`)
      .field('issuedOn', '2026-10-05')
      .attach('file', file, 'faktura-sklad.pdf')
      .expect(201);
    const candidates = await f
      .get('/api/admin/finance/supplier-documents')
      .query({ supplierId })
      .expect(200);
    expect(candidates.body.find((c: { id: string }) => c.id === sd.body.id)).toMatchObject({
      takenOverBy: null,
      superseded: false,
      siteCode: expect.any(String),
    });
    const requestId = randomUUID();
    const take = (extra: object = {}) =>
      f
        .post('/api/admin/finance/documents/take-over')
        .send({ requestId, supplierDocumentId: sd.body.id, handoverMonth: '2026-10', ...extra });
    const doc = (await take().expect(201)).body;
    expect(doc).toMatchObject({
      source: 'SUPPLIER_DOCUMENT',
      supplierDocument: { id: sd.body.id },
      supplier: { id: supplierId, name: supplierName },
      documentNumber: sd.body.documentNumber,
      issuedOn: '2026-10-05',
      handoverMonth: '2026-10',
      kind: 'INVOICE',
      missing: [],
    });
    // No copy in Finance's storage; the bytes come from the core, unchanged.
    const row = await f.prisma.document.findUniqueOrThrow({ where: { code: doc.code } });
    expect(row.storageKey).toBeNull();
    const content = await bytes(f.get(`/api/admin/finance/documents/${doc.code}/content`)).expect(
      200,
    );
    expect(Buffer.compare(content.body as Buffer, file)).toBe(0);
    // Replay → the same; another request → refused; the same file as an upload → refused.
    expect((await take().expect(201)).body.code).toBe(doc.code);
    expect((await take({ kind: 'OTHER' }).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
    const second = await f
      .post('/api/admin/finance/documents/take-over')
      .send({ requestId: randomUUID(), supplierDocumentId: sd.body.id })
      .expect(409);
    expect(second.body.code).toBe('ALREADY_TAKEN_OVER');
    expect((await receive(base(), file).expect(409)).body.code).toBe('DUPLICATE_DOCUMENT');
    const listed = await f.get('/api/admin/finance/supplier-documents').expect(200);
    expect(listed.body.find((c: { id: string }) => c.id === sd.body.id).takenOverBy).toBe(doc.code);
    // An unknown supplier document is simply not found.
    await f
      .post('/api/admin/finance/documents/take-over')
      .send({ requestId: randomUUID(), supplierDocumentId: randomUUID() })
      .expect(404);
  });

  it('database roles: the runtime role sees only schema finance and cannot delete or change structure', async () => {
    const doc = (await receive(base(), pdf(randomUUID())).expect(201)).body;
    const runtime = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeDatabaseUrl! }),
    });
    const owner = new PrismaClient({
      adapter: new PrismaPg({ connectionString: financeOwnerDatabaseUrl! }),
    });
    try {
      for (const sql of [
        'SELECT 1 FROM public.users LIMIT 1',
        'SELECT 1 FROM public.suppliers LIMIT 1',
        'SELECT 1 FROM public.user_sessions LIMIT 1',
        'CREATE TABLE public.x (id int)',
        `DELETE FROM finance.documents WHERE code = '${doc.code}'`,
        'TRUNCATE finance.document_events',
        'ALTER TABLE finance.documents DISABLE TRIGGER documents_guard',
        'DROP TABLE finance.documents',
        'CREATE TABLE finance.x (id int)',
      ])
        await expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(
          /permission denied|must be owner/,
        );
      for (const sql of ['SELECT 1 FROM public.users LIMIT 1', 'CREATE TABLE public.x (id int)'])
        await expect(owner.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
      // The other direction (ADR 0041): the core's own runtime role cannot read or write Finance.
      const core = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
      try {
        for (const sql of [
          'SELECT 1 FROM finance.documents LIMIT 1',
          'SELECT 1 FROM finance.exports LIMIT 1',
          `UPDATE finance.documents SET description = 'x' WHERE code = '${doc.code}'`,
          'CREATE TABLE finance.x (id int)',
        ])
          await expect(core.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
      } finally {
        await core.$disconnect();
      }
      const attrs = await owner.$queryRaw<
        { rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]
      >`
        SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
      expect(attrs).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false }]);
      // The guards hold even for the owner.
      const raw = (sql: string) => owner.$executeRawUnsafe(sql);
      await expect(
        raw(`UPDATE finance.documents SET sha256 = repeat('a', 64) WHERE code = '${doc.code}'`),
      ).rejects.toThrow(/immutable/);
      await expect(
        raw(`UPDATE finance.documents SET description = 'x' WHERE code = '${doc.code}'`),
      ).rejects.toThrow(/next version/);
      await expect(raw(`DELETE FROM finance.documents WHERE code = '${doc.code}'`)).rejects.toThrow(
        /never deleted/,
      );
      await expect(
        raw(`UPDATE finance.document_events SET reason = 'x' WHERE document_id = '${doc.id}'`),
      ).rejects.toThrow(/immutable record/);
      await expect(
        raw(
          `UPDATE finance.documents SET description = 'x', version = version + 1 WHERE code = '${doc.code}'`,
        ),
      ).rejects.toThrow(/has no event/);
    } finally {
      await runtime.$disconnect();
      await owner.$disconnect();
    }
  });

  it('the internal contract: service token required, user session required, not reachable without both', async () => {
    const path = '/api/internal/v1/finance/principal';
    const body = { method: 'GET', origin: null, secFetchSite: null };
    // A browser with a session but no service token.
    const browser = await core().post(path).set('Cookie', 'ayvo_session=x').send(body).expect(401);
    expect(browser.body.code).toBe('SERVICE_UNAUTHENTICATED');
    await core()
      .post(path)
      .set('Authorization', 'Bearer wrong-token-wrong-token-wrong-token-wrong-to')
      .set('x-ayvo-session', 'x')
      .send(body)
      .expect(401);
    const noSession = await core()
      .post(path)
      .set('Authorization', `Bearer ${f.env.FINANCE_SERVICE_TOKEN}`)
      .send(body)
      .expect(401);
    expect(noSession.body.code).toBe('UNAUTHENTICATED');
    // The core's CSRF rule on what Finance forwards: another origin's write is refused.
    const csrf = await core()
      .post(path)
      .set('Authorization', `Bearer ${f.env.FINANCE_SERVICE_TOKEN}`)
      .set('x-ayvo-session', 'x')
      .send({ method: 'POST', origin: 'https://evil.example', secFetchSite: 'cross-site' })
      .expect(403);
    expect(csrf.body.code).toBe('CSRF_REJECTED');
    const viaFinance = await request(f.app.getHttpServer())
      .post('/api/admin/finance/documents/FD-000001/void')
      .set('Cookie', TEST_SESSION_COOKIE)
      .set('Origin', 'https://evil.example')
      .send({ expectedVersion: 1, reason: 'cizí web' });
    expect([viaFinance.status, viaFinance.body.code]).toEqual([403, 'CSRF_REJECTED']);
    // No session cookie at Finance: 401 before anything else.
    await request(f.app.getHttpServer()).get('/api/admin/finance/documents').expect(401);
  });

  it('the core down: Finance is alive but fails closed (503), never grants access', async () => {
    const down = await createFinanceTestApp({ coreUrl: 'http://127.0.0.1:9' });
    try {
      await down.get('/api/admin/finance/health/live').expect(200);
      expect((await down.get('/api/admin/finance/health/ready').expect(503)).body.code).toBe(
        'FINANCE_DEPENDENCY_UNAVAILABLE',
      );
      for (const path of ['/api/admin/finance/documents', '/api/admin/finance/suppliers'])
        expect((await down.get(path).expect(503)).body.code).toBe('FINANCE_DEPENDENCY_UNAVAILABLE');
    } finally {
      await down.close();
    }
    const wrongToken = await createFinanceTestApp({
      finance: { FINANCE_SERVICE_TOKEN: 'a'.repeat(43) },
    });
    try {
      // Our own misconfiguration is "unavailable", not "sign in again".
      expect((await wrongToken.get('/api/admin/finance/documents').expect(503)).body.code).toBe(
        'FINANCE_DEPENDENCY_UNAVAILABLE',
      );
    } finally {
      await wrongToken.close();
    }
  });

  it('permissions with real sessions: granted only to ADMIN; another role and no session are refused; a revoked role is refused on the next request', async () => {
    const real = await createFinanceTestApp({ core: { auth: 'real' } });
    try {
      const grants = await real.core.prisma.rolePermission.findMany({
        where: { permissionCode: { startsWith: 'finance:' }, roleCode: 'ADMIN' },
        select: { roleCode: true, permissionCode: true },
        orderBy: { permissionCode: 'asc' },
      });
      expect(grants).toEqual([
        { roleCode: 'ADMIN', permissionCode: 'finance:bank_read' },
        { roleCode: 'ADMIN', permissionCode: 'finance:bank_sync' },
        { roleCode: 'ADMIN', permissionCode: 'finance:documents_manage' },
        { roleCode: 'ADMIN', permissionCode: 'finance:documents_read' },
        { roleCode: 'ADMIN', permissionCode: 'finance:exports_manage' },
      ]);
      const doc = (await receive(base(), pdf(randomUUID())).expect(201)).body;
      const user = await prepareInvitedUser(real.core, {
        email: `fin-${randomUUID()}@ayvo.test`,
        displayName: 'Bez financí',
      });
      await real.core.prisma.userRole.create({
        data: { userId: user.id, roleCode: 'SALES', grantReason: 'test: no finance permission' },
      });
      const cookie = await sessionCookie(real.core, user.email);
      for (const path of [
        '/api/admin/finance/documents',
        `/api/admin/finance/documents/${doc.code}`,
        `/api/admin/finance/documents/${doc.code}/content`,
        '/api/admin/finance/suppliers',
        '/api/admin/finance/supplier-documents',
      ])
        expect([path, (await real.get(path, cookie)).status]).toEqual([path, 403]);
      expect(
        (
          await real.post(`/api/admin/finance/documents/${doc.code}/void`, cookie).send({
            expectedVersion: 1,
            reason: 'neoprávněně',
          })
        ).status,
      ).toBe(403);
      await request(real.app.getHttpServer()).get('/api/admin/finance/documents').expect(401);

      // A custom role with only the Finance permissions (never a second ADMIN in the shared DB).
      const roleCode = `FIN_${randomUUID().slice(0, 8).toUpperCase()}`;
      await real.core.prisma.role.create({
        data: { code: roleCode, name: 'Finance (test)', description: 'test' },
      });
      await real.core.prisma.rolePermission.createMany({
        data: ['finance:documents_read', 'finance:documents_manage'].map((permissionCode) => ({
          roleCode,
          permissionCode,
        })),
      });
      const admin = await prepareInvitedUser(real.core, {
        email: `fin-role-${randomUUID()}@ayvo.test`,
        displayName: 'Finance role',
      });
      await real.core.prisma.userRole.create({
        data: { userId: admin.id, roleCode, grantReason: 'test: finance' },
      });
      const adminCookie = await sessionCookie(real.core, admin.email);
      await real.get('/api/admin/finance/documents', adminCookie).expect(200);
      // Revoking the role takes effect on the very next request (no cache in Finance).
      await real.core.prisma.userRole.updateMany({
        where: { userId: admin.id, roleCode },
        data: { revokedAt: new Date(), revokeReason: 'test' },
      });
      await real.get('/api/admin/finance/documents', adminCookie).expect(403);
    } finally {
      await real.close();
    }
  });
});
