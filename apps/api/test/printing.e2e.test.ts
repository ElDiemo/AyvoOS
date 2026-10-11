import type {
  BottleCreationHistoryResponse,
  LabelPrintJob,
  LabelPrintJobListResponse,
  LabelTemplateVersion,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qrSymbolInfo, QR_QUIET_ZONE_MODULES } from '../src/labels/label-pdf-renderer.js';
import { createTemplate, QR_DEFAULT, registerBottles } from './support/fixtures.js';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('label print jobs (label-production module)', () => {
  let t: TestApp;
  let version: LabelTemplateVersion;

  beforeAll(async () => {
    t = await createTestApp();
    version = await createTemplate(t.app);
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());
  const generate = async (code: string) =>
    (await http().post(`/api/admin/label-print-jobs/${code}/generate`).expect(200))
      .body as LabelPrintJob;
  const download = async (job: LabelPrintJob) => {
    const res = await http()
      .get(job.downloadUrl!)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    return res;
  };

  async function batchBottles(batchCode: string) {
    return t.prisma.bottle.findMany({
      where: { creationBatch: { code: batchCode } },
      orderBy: { serial: 'asc' },
    });
  }

  it('registration creates a PENDING print job for exactly the new bottles, in code order', async () => {
    const { batch, printJob } = await registerBottles(t.app, version.versionId, 12);
    expect(printJob).toMatchObject({
      status: 'PENDING',
      environment: 'test',
      qrErrorCorrection: 'Q',
      labelCount: 12,
      creationBatchCode: batch.code,
      labelTemplate: { versionId: version.versionId },
      downloadUrl: null,
    });
    const items = await t.prisma.labelPrintJobItem.findMany({
      where: { printJob: { code: printJob!.code } },
      orderBy: { position: 'asc' },
    });
    const bottles = await batchBottles(batch.code);
    expect(items.map((i) => i.bottleId)).toEqual(bottles.map((b) => b.id));
    // The exact QR URL of every label is stored with the immutable job.
    expect(items.map((i) => i.qrUrl)).toEqual(
      bottles.map((b) => `${TEST_QR_BASE_URL}/${b.publicToken}`),
    );
  });

  it('renders a 50-page PDF: exact page size, each page encodes its own bottle URL at the stored position', async () => {
    const { batch, printJob } = await registerBottles(t.app, version.versionId, 50);
    const done = await generate(printJob!.code);
    expect(done).toMatchObject({ status: 'COMPLETED', attempts: 1, failureReason: null });
    expect(done.completedAt).not.toBeNull();

    const res = await download(done);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(
        `attachment; filename="${done.code}_${batch.code}_${version.templateName}-v1_50-labels.pdf"`,
      ),
    );
    const pdf = await openPdf(res.body as Buffer);
    expect(pdf.pageCount).toBe(50);
    for (const size of pdf.pageSizesMm) {
      expect(size.widthMm).toBeCloseTo(70, 2);
      expect(size.heightMm).toBeCloseTo(110, 2);
    }

    const bottles = await batchBottles(batch.code);
    for (let page = 1; page <= 50; page++) {
      const decoded = await decodeQrOnPage(pdf, page, 8);
      const url = `${TEST_QR_BASE_URL}/${bottles[page - 1]!.publicToken}`;
      expect(decoded?.data, `page ${page}`).toBe(url);

      // The QR symbol sits where the designer placed it (±1 module).
      const { moduleMm, version: qrVersion } = qrSymbolInfo(url, QR_DEFAULT.widthMm, 'Q');
      expect(decoded!.version).toBe(qrVersion);
      const inset = QR_QUIET_ZONE_MODULES * moduleMm;
      expect(Math.abs(decoded!.symbolMm.left - (QR_DEFAULT.xMm + inset))).toBeLessThan(moduleMm);
      expect(Math.abs(decoded!.symbolMm.top - (QR_DEFAULT.yMm + inset))).toBeLessThan(moduleMm);
      // Not a production process: every label carries the visible DEV marker.
      if (page === 1 || page === 50)
        expect(await pageText(pdf, page)).toContain('DEV - NOT FOR PRODUCTION');
    }
  });

  it('a failed generation keeps the batch and bottles; retry renders the SAME bottles and creates none', async () => {
    const { batch, printJob } = await registerBottles(t.app, version.versionId, 5);
    const bottlesBefore = await t.prisma.bottle.count();
    const batchBottlesBefore = await batchBottles(batch.code);

    t.renderer.failuresRemaining = 1;
    const failed = await generate(printJob!.code);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, downloadUrl: null });
    expect(failed.failureReason).toMatch(/PDF generation failed/);
    // No internal details (paths, stack traces) in the API response.
    expect(JSON.stringify(failed)).not.toMatch(/internal|secret|Error:/);
    await http().get(`/api/admin/label-print-jobs/${failed.code}/pdf`).expect(409);

    // The bottles are untouched by the failure.
    expect(await t.prisma.bottle.count()).toBe(bottlesBefore);
    expect(await batchBottles(batch.code)).toEqual(batchBottlesBefore);
    expect(
      (await http().get(`/api/admin/bottle-batches/${batch.code}`).expect(200)).body,
    ).toMatchObject({ quantityCreated: 5 });

    const retried = await generate(printJob!.code);
    expect(retried).toMatchObject({
      status: 'COMPLETED',
      attempts: 2,
      failureReason: null,
      failedAt: null,
    });
    expect(await t.prisma.bottle.count()).toBe(bottlesBefore);

    const pdf = await openPdf((await download(retried)).body as Buffer);
    expect(pdf.pageCount).toBe(5);
    for (let page = 1; page <= 5; page++) {
      expect((await decodeQrOnPage(pdf, page, 8))?.data).toBe(
        `${TEST_QR_BASE_URL}/${batchBottlesBefore[page - 1]!.publicToken}`,
      );
    }
  });

  it('refuses to regenerate a completed job; a new print job for the batch reuses the same bottles', async () => {
    const { batch, printJob } = await registerBottles(t.app, version.versionId, 3);
    await generate(printJob!.code);
    await http().post(`/api/admin/label-print-jobs/${printJob!.code}/generate`).expect(409);

    const bottlesBefore = await t.prisma.bottle.count();
    const second = (
      await http().post(`/api/admin/bottle-batches/${batch.code}/print-jobs`).expect(201)
    ).body as LabelPrintJob;
    expect(second.code).not.toBe(printJob!.code);
    expect(second).toMatchObject({
      status: 'PENDING',
      labelCount: 3,
      labelTemplate: { versionId: version.versionId },
    });
    expect(await t.prisma.bottle.count()).toBe(bottlesBefore);

    const items = (code: string) =>
      t.prisma.labelPrintJobItem.findMany({
        where: { printJob: { code } },
        orderBy: { position: 'asc' },
      });
    expect((await items(second.code)).map((i) => i.bottleId)).toEqual(
      (await items(printJob!.code)).map((i) => i.bottleId),
    );

    const list = (
      await http().get(`/api/admin/bottle-batches/${batch.code}/print-jobs`).expect(200)
    ).body as LabelPrintJobListResponse;
    expect(list.items.map((j) => j.code)).toEqual([second.code, printJob!.code]);
  });

  it('historical print jobs keep their template version after the template changes', async () => {
    const { printJob } = await registerBottles(t.app, version.versionId, 2);
    await http()
      .post(`/api/admin/label-templates/${version.templateId}/versions`)
      .send({
        layout: {
          artworkId: version.artwork.id,
          widthMm: 70,
          heightMm: 110,
          elements: [{ ...QR_DEFAULT, xMm: 5, yMm: 5 }],
        },
      })
      .expect(200);
    const done = await generate(printJob!.code);
    expect(done.labelTemplate.versionNumber).toBe(1);
    const pdf = await openPdf((await download(done)).body as Buffer);
    const decoded = await decodeQrOnPage(pdf, 1, 8);
    // Still at the v1 position (48.2 / 78.5 mm), not the v2 one (5 / 5 mm).
    expect(decoded!.symbolMm.left).toBeGreaterThan(48);
    expect(decoded!.symbolMm.top).toBeGreaterThan(78);
  });

  it('protects print job identity at database level', async () => {
    const job = await t.prisma.labelPrintJob.findFirstOrThrow();
    await expect(
      t.prisma.labelPrintJob.update({
        where: { id: job.id },
        data: { labelCount: job.labelCount + 1 },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.labelPrintJob.update({
        where: { id: job.id },
        data: { publicBaseUrl: 'https://evil.example' },
      }),
    ).rejects.toThrow();
    await expect(t.prisma.labelPrintJob.delete({ where: { id: job.id } })).rejects.toThrow();
  });

  it('creation history lists batches newest first with the state of their latest print job', async () => {
    // Own template: an earlier test superseded `version` with a newer one.
    const { versionId } = await createTemplate(t.app);
    const older = await registerBottles(t.app, versionId, 2);
    const newer = await registerBottles(t.app, versionId, 3);
    // The older batch gets a reprint job; only the most recent job counts as its label state.
    await generate(older.printJob!.code);
    const completed = await generate(newer.printJob!.code);
    const reprint = (
      await http().post(`/api/admin/bottle-batches/${older.batch.code}/print-jobs`).expect(201)
    ).body as LabelPrintJob;

    const history = (
      await http().get('/api/admin/bottle-creation-history?pageSize=100').expect(200)
    ).body as BottleCreationHistoryResponse;
    const codes = history.items.map((i) => i.code);
    expect(codes.indexOf(newer.batch.code)).toBeLessThan(codes.indexOf(older.batch.code));
    expect(history.total).toBeGreaterThanOrEqual(2);
    expect(history.items.find((i) => i.code === newer.batch.code)).toEqual({
      ...newer.batch,
      latestPrintJob: {
        code: completed.code,
        status: 'COMPLETED',
        downloadUrl: `/api/admin/label-print-jobs/${completed.code}/pdf`,
      },
    });
    expect(history.items.find((i) => i.code === older.batch.code)?.latestPrintJob).toEqual({
      code: reprint.code,
      status: 'PENDING',
      downloadUrl: null,
    });

    const page = (await http().get('/api/admin/bottle-creation-history?pageSize=1').expect(200))
      .body as BottleCreationHistoryResponse;
    expect(page.items).toHaveLength(1);
    await http().get('/api/admin/bottle-creation-history?pageSize=0').expect(400);
  });

  it('returns 404 for unknown jobs and batches', async () => {
    await http().get('/api/admin/label-print-jobs/PJ-999999').expect(404);
    await http().post('/api/admin/label-print-jobs/nonsense/generate').expect(400);
    await http().get('/api/admin/bottle-batches/BC-999999/print-jobs').expect(404);
  });
});
