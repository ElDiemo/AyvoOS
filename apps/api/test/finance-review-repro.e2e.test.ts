import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, hasDatabase, TEST_APP_ORIGIN, type TestApp } from './support/test-app.js';

// Reproduction of review findings F-R2, F-R5, F-R6 on the pre-fix code (temporary file).
const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);
describe.skipIf(!hasDatabase)('review repro', () => {
  let t: TestApp;
  let supplierId: string;
  const http = () => request(t.app.getHttpServer());
  const post = (p: string) => http().post(`/api/admin/finance/${p}`).set('Origin', TEST_APP_ORIGIN);
  const upload = (fields: Record<string, string>, file: Buffer) => {
    let r = post('documents');
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, 'f.pdf');
  };
  beforeAll(async () => {
    t = await createTestApp();
    supplierId = (
      await http().post('/api/admin/suppliers').set('Origin', TEST_APP_ORIGIN)
        .send({ requestId: randomUUID(), name: `R ${randomUUID().slice(0, 6)}`, companyId: null, vatId: null })
        .expect(201)
    ).body.id;
  });
  afterAll(() => t?.close());

  it('F-R5 upload: same requestId + same file + other metadata is a conflict', async () => {
    const requestId = randomUUID();
    const file = pdf(randomUUID());
    const f = { requestId, supplierId, kind: 'INVOICE', documentNumber: 'R5-1', issuedOn: '2013-03-02' };
    await upload(f, file).expect(201);
    const res = await upload({ ...f, documentNumber: 'R5-OTHER' }, file);
    expect(res.status).toBe(409);
  });

  it('F-R5 export: same requestId with another note is a conflict', async () => {
    await upload({ requestId: randomUUID(), supplierId, kind: 'INVOICE', documentNumber: 'R5-E', issuedOn: '2013-04-02' }, pdf(randomUUID())).expect(201);
    const requestId = randomUUID();
    const body = { requestId, periodFrom: '2013-04-01', periodTo: '2013-04-30', mode: 'FULL', note: 'a' };
    await post('exports').send(body).expect(201);
    const res = await post('exports').send({ ...body, note: 'b' });
    expect(res.status).toBe(409);
  });

  it('F-R5 export: two concurrent identical requests give one export', async () => {
    await upload({ requestId: randomUUID(), supplierId, kind: 'INVOICE', documentNumber: 'R5-C', issuedOn: '2013-05-02' }, pdf(randomUUID())).expect(201);
    const body = { requestId: randomUUID(), periodFrom: '2013-05-01', periodTo: '2013-05-31', mode: 'FULL' };
    const [a, b] = await Promise.all([post('exports').send(body), post('exports').send(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.code).toBe(b.body.code);
  });

  it('F-R6: a change after export A stays visible on A after export B', async () => {
    const d = (await upload({ requestId: randomUUID(), supplierId, kind: 'INVOICE', documentNumber: 'R6', issuedOn: '2013-06-02' }, pdf(randomUUID())).expect(201)).body;
    const p = { periodFrom: '2013-06-01', periodTo: '2013-06-30' };
    const a = (await post('exports').send({ requestId: randomUUID(), ...p, mode: 'FULL' }).expect(201)).body;
    await post(`documents/${d.code}/correct`).send({ supplierId, kind: 'INVOICE', documentNumber: 'R6-fixed', issuedOn: '2013-06-02', expectedVersion: 1, reason: 'oprava' }).expect(200);
    await post('exports').send({ requestId: randomUUID(), ...p, mode: 'SUPPLEMENT' }).expect(201);
    const detailA = (await http().get(`/api/admin/finance/exports/${a.code}`).expect(200)).body;
    expect(detailA.laterChanges.map((l: { code: string }) => l.code)).toContain(d.code);
  });

  it('F-R2: a correction between preview and confirmation is refused as stale', async () => {
    const d = (await upload({ requestId: randomUUID(), supplierId, kind: 'INVOICE', documentNumber: 'R2', issuedOn: '2013-07-02', totalAmount: '10.00', currency: 'CZK' }, pdf(randomUUID())).expect(201)).body;
    const p = { periodFrom: '2013-07-01', periodTo: '2013-07-31', mode: 'FULL' };
    const preview = (await http().get('/api/admin/finance/exports/preview').query(p).expect(200)).body;
    await post(`documents/${d.code}/correct`).send({ supplierId, kind: 'INVOICE', documentNumber: 'R2', issuedOn: '2013-07-02', totalAmount: '99.00', currency: 'CZK', expectedVersion: 1, reason: 'oprava' }).expect(200);
    const res = await post('exports').send({ requestId: randomUUID(), ...p, previewFingerprint: preview.fingerprint });
    expect(res.status).toBe(409);
  });
});
