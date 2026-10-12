import type { LabelPrintJob, LabelTemplateVersion } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_QR_BASE_URL } from '../src/common/qr-policy.js';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';

/**
 * DEV / production QR separation (ADR 0014), tested on the print-job guards themselves: the
 * misconfigured processes below bypass the startup validation on purpose (see test-app.ts).
 */
describe.skipIf(!hasDatabase)('DEV / production QR separation', () => {
  let dev: TestApp; // non-production process, DEV-style base URL
  let prod: TestApp; // production process, production base URL
  let devVersion: LabelTemplateVersion;
  let prodVersion: LabelTemplateVersion;

  beforeAll(async () => {
    dev = await createTestApp({
      APP_ENV: 'development',
      PUBLIC_QR_BASE_URL: 'https://dev.ayvo.co/q',
    });
    prod = await createTestApp(
      {},
      { APP_ENV: 'production', PUBLIC_QR_BASE_URL: PRODUCTION_QR_BASE_URL },
    );
    devVersion = await createTemplate(dev.app);
    prodVersion = await createTemplate(prod.app);
  });
  afterAll(async () => {
    await dev?.close();
    await prod?.close();
  });

  const generate = (t: TestApp, code: string) =>
    request(t.app.getHttpServer()).post(`/api/admin/label-print-jobs/${code}/generate`);
  const pdfOf = async (t: TestApp, job: LabelPrintJob) =>
    openPdf(
      (
        await request(t.app.getHttpServer())
          .get(job.downloadUrl!)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200)
      ).body as Buffer,
    );

  it('DEV labels encode the DEV URL, record the environment and carry the DEV marker', async () => {
    const { batch, printJob } = await registerBottles(dev.app, devVersion.versionId, 2);
    expect(printJob).toMatchObject({ environment: 'development', qrErrorCorrection: 'Q' });
    const job = (await generate(dev, printJob!.code).expect(200)).body as LabelPrintJob;
    const pdf = await pdfOf(dev, job);
    const bottle = await dev.prisma.bottle.findUniqueOrThrow({
      where: { code: batch.firstBottleCode },
    });
    expect((await decodeQrOnPage(pdf, 1))?.data).toBe(
      `https://dev.ayvo.co/q/${bottle.publicToken}`,
    );
    expect(await pageText(pdf, 1)).toContain('DEV - NOT FOR PRODUCTION');
  });

  it('production labels encode https://qr.ayvo.co/<token> and carry no DEV marker', async () => {
    const { batch, printJob } = await registerBottles(prod.app, prodVersion.versionId, 2);
    expect(printJob).toMatchObject({ environment: 'production' });
    const job = (await generate(prod, printJob!.code).expect(200)).body as LabelPrintJob;
    const pdf = await pdfOf(prod, job);
    const bottle = await prod.prisma.bottle.findUniqueOrThrow({
      where: { code: batch.firstBottleCode },
    });
    expect((await decodeQrOnPage(pdf, 1))?.data).toBe(
      `${PRODUCTION_QR_BASE_URL}/${bottle.publicToken}`,
    );
    expect(await pageText(pdf, 1)).not.toContain('DEV');
  });

  it('a correctly configured production process refuses to render a DEV job', async () => {
    const { printJob } = await registerBottles(dev.app, devVersion.versionId, 1);
    const res = await generate(prod, printJob!.code).expect(403);
    expect(res.body.message).toMatch(/production requires the public QR base URL/);
  });

  it('designer settings preview this environment, never production', async () => {
    const settings = (
      await request(dev.app.getHttpServer()).get('/api/admin/label-designer/settings').expect(200)
    ).body as { qrPreviewUrl: string; qrErrorCorrection: string };
    expect(settings.qrPreviewUrl).toMatch(/^https:\/\/dev\.ayvo\.co\/q\/[A-Za-z0-9_-]{22}$/);
    expect(settings.qrErrorCorrection).toBe(dev.env.LABEL_QR_ERROR_CORRECTION);
  });

  describe('refusal: a production process with a non-production base URL', () => {
    let misconfigured: TestApp;
    beforeAll(async () => {
      misconfigured = await createTestApp(
        {},
        { APP_ENV: 'production', PUBLIC_QR_BASE_URL: 'https://dev.ayvo.co/q' },
      );
    });
    afterAll(() => misconfigured?.close());

    it('refuses to create print jobs', async () => {
      const { batch } = await registerBottles(dev.app, devVersion.versionId, 1);
      const before = await misconfigured.prisma.labelPrintJob.count();
      const res = await request(misconfigured.app.getHttpServer())
        .post(`/api/admin/bottle-batches/${batch.code}/print-jobs`)
        .expect(403);
      expect(res.body.message).toMatch(
        /production requires the public QR base URL https:\/\/qr\.ayvo\.co/,
      );
      expect(await misconfigured.prisma.labelPrintJob.count()).toBe(before);
    });

    it('refuses to render existing DEV jobs (they stay PENDING)', async () => {
      const { printJob } = await registerBottles(dev.app, devVersion.versionId, 1);
      await generate(misconfigured, printJob!.code).expect(403);
      expect(
        (
          await misconfigured.prisma.labelPrintJob.findUniqueOrThrow({
            where: { code: printJob!.code },
          })
        ).status,
      ).toBe('PENDING');
    });
  });

  describe('refusal: a non-production process with the production base URL', () => {
    let misconfigured: TestApp;
    beforeAll(async () => {
      misconfigured = await createTestApp(
        {},
        { APP_ENV: 'development', PUBLIC_QR_BASE_URL: PRODUCTION_QR_BASE_URL },
      );
    });
    afterAll(() => misconfigured?.close());

    it('refuses to create print jobs', async () => {
      const { batch } = await registerBottles(dev.app, devVersion.versionId, 1);
      const res = await request(misconfigured.app.getHttpServer())
        .post(`/api/admin/bottle-batches/${batch.code}/print-jobs`)
        .expect(403);
      expect(res.body.message).toMatch(/never encode a production QR URL/);
    });

    it('refuses to render existing production jobs', async () => {
      const { printJob } = await registerBottles(prod.app, prodVersion.versionId, 1);
      await generate(misconfigured, printJob!.code).expect(403);
      // ...and so does any correctly configured non-production process.
      await generate(dev, printJob!.code).expect(403);
    });
  });

  it('the database rejects print jobs that break the rule, whatever the application does', async () => {
    const batch = await dev.prisma.bottleCreationBatch.findFirstOrThrow();
    const base = {
      creationBatchId: batch.id,
      labelTemplateVersionId: batch.labelTemplateVersionId,
      siteId: INITIAL_SITE_ID,
      labelCount: 1,
      qrErrorCorrection: 'Q' as const,
    };
    await expect(
      dev.prisma.labelPrintJob.create({
        data: {
          ...base,
          serial: 900001n,
          code: 'PJ-900001',
          appEnvironment: 'development',
          publicBaseUrl: PRODUCTION_QR_BASE_URL,
        },
      }),
    ).rejects.toThrow();
    await expect(
      dev.prisma.labelPrintJob.create({
        data: {
          ...base,
          serial: 900002n,
          code: 'PJ-900002',
          appEnvironment: 'production',
          publicBaseUrl: 'https://dev.ayvo.co/q',
        },
      }),
    ).rejects.toThrow();
  });

  it('the database rejects a label QR URL that is not base URL + the bottle token', async () => {
    const item = await dev.prisma.labelPrintJobItem.findFirstOrThrow({
      include: { printJob: true },
    });
    const other = await dev.prisma.bottle.findFirstOrThrow({
      where: { id: { not: item.bottleId } },
    });
    const job = await dev.prisma.labelPrintJob.findFirstOrThrow({ where: { id: item.printJobId } });
    await expect(
      dev.prisma.labelPrintJobItem.create({
        data: {
          printJobId: job.id,
          position: 999,
          bottleId: other.id,
          qrUrl: `${job.publicBaseUrl}/${'A'.repeat(22)}`,
        },
      }),
    ).rejects.toThrow();
  });
});
