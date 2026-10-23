import { randomUUID } from 'node:crypto';
import type {
  BottleRegistrationResponse,
  CrateLabelPrintJob,
  CrateRegistration,
  CrateType,
  LabelDesignerSettings,
  LabelPrintJob,
  LabelTemplateVersion,
  ManagedWorkstation,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTemplate,
  layout,
  registerBottles,
  uniqueName,
  uploadArtwork,
} from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Owner 2026-10-23: missing (physically validated) QR settings refuse ONLY the creation,
 * rendering, preview and handing out of our own QR labels — never the start of the application,
 * sign-in, Obchod, reading bottles and history, or carrier labels (dispatch-printing.e2e.test.ts).
 * `configured` is a normal process; the others share its database but run without the settings
 * (null, as production without them), with another error correction, or a larger minimum.
 */
describe.skipIf(!hasDatabase)('QR label settings guard only our QR labels', () => {
  let configured: TestApp;
  let missing: TestApp;
  let changedLevel: TestApp;
  let largerMinimum: TestApp;
  let version: LabelTemplateVersion;
  let registered: BottleRegistrationResponse;
  let crateJob: CrateLabelPrintJob;
  let crateCode: string;
  let crateType: CrateType;
  let station: ManagedWorkstation;
  const sfx = () => randomUUID().slice(0, 6).toUpperCase();
  const http = (t: TestApp) => request(t.app.getHttpServer());
  const refused = (res: request.Response, code: string) =>
    expect([res.status, (res.body as { code?: string }).code], JSON.stringify(res.body)).toEqual([
      409,
      code,
    ]);

  beforeAll(async () => {
    configured = await createTestApp();
    missing = await createTestApp(
      {},
      { LABEL_QR_MIN_SIZE_MM: null, LABEL_QR_ERROR_CORRECTION: null },
    );
    changedLevel = await createTestApp({}, { LABEL_QR_ERROR_CORRECTION: 'H' });
    largerMinimum = await createTestApp({}, { LABEL_QR_MIN_SIZE_MM: 40 });

    // Made while configured: a template, bottles with a COMPLETED print job, a crate label job.
    version = await createTemplate(configured.app);
    registered = await registerBottles(configured.app, version.versionId, 2);
    await http(configured)
      .post(`/api/admin/label-print-jobs/${registered.printJob!.code}/generate`)
      .expect(200);
    crateType = (
      await http(configured)
        .post('/api/admin/catalog/crate-types')
        .send({
          requestId: randomUUID(),
          code: `CRATE-${sfx()}`,
          name: 'Vratná bedna 40',
          capacity: 40,
          categoryCodes: ['HAND_SOAP'],
          reason: 'typ bedny pro test',
        })
        .expect(201)
    ).body as CrateType;
    crateCode = (
      (
        await http(configured)
          .post('/api/admin/crate-registrations')
          .send({ requestId: randomUUID(), crateTypeCode: crateType.code, quantity: 1 })
          .expect(201)
      ).body as CrateRegistration
    ).crateCodes[0]!;
    crateJob = (
      await http(configured)
        .post('/api/admin/crate-label-print-jobs')
        .send({ requestId: randomUUID(), crateCodes: [crateCode], widthMm: 70, heightMm: 40 })
        .expect(201)
    ).body as CrateLabelPrintJob;
    station = (
      await http(configured)
        .post('/api/admin/workstations')
        .send({
          requestId: randomUUID(),
          code: `WS-${sfx()}`,
          name: 'Etiketovací stůl',
          mode: 'FILLING',
          categoryCode: 'SHOWER_GEL',
          reason: 'nové pracoviště',
        })
        .expect(201)
    ).body as ManagedWorkstation;
  });
  afterAll(async () => {
    await configured?.close();
    await missing?.close();
    await changedLevel?.close();
    await largerMinimum?.close();
  });

  it('without the settings the application runs: health, sign-in state, Obchod', async () => {
    expect(missing.env.LABEL_QR_MIN_SIZE_MM).toBeNull();
    await http(missing).get('/api/health').expect(200);
    await http(missing).get('/api/auth/me').expect(200);
    await http(missing).get('/api/admin/sales/overview').expect(200);
    const created = await http(missing)
      .post('/api/admin/sales/prospects')
      .send({
        requestId: randomUUID(),
        name: `Hotel Bez QR ${sfx()}`,
        countryCode: 'CZ',
        city: null,
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        roomsEstimate: null,
        accommodationType: null,
        website: null,
        source: null,
        priority: null,
        note: null,
        ownerId: null,
        contact: null,
        acknowledgeDuplicates: false,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  it('bottles, print history and templates stay readable; the settings answer null', async () => {
    const settings = (await http(missing).get('/api/admin/label-designer/settings').expect(200))
      .body as LabelDesignerSettings;
    expect(settings).toMatchObject({ qrMinSizeMm: null, qrErrorCorrection: null });
    await http(missing).get(`/api/admin/bottles/${registered.batch.firstBottleCode}`).expect(200);
    await http(missing).get('/api/admin/bottle-creation-history').expect(200);
    await http(missing)
      .get(`/api/admin/bottle-batches/${registered.batch.code}/print-jobs`)
      .expect(200);
    await http(missing).get(`/api/admin/label-print-jobs/${registered.printJob!.code}`).expect(200);
    await http(missing).get(`/api/admin/crate-label-print-jobs/${crateJob.code}`).expect(200);
    await http(missing).get(`/api/admin/label-template-versions/${version.versionId}`).expect(200);
    // The sheet that serves to validate the settings physically needs none.
    await http(missing).get('/api/admin/label-calibration/qr-validation-sheet.pdf').expect(200);
  });

  it('every operation that creates, renders or hands out our QR labels is refused', async () => {
    const MISSING = 'QR_LABEL_SETTINGS_MISSING';
    const artwork = await uploadArtwork(missing.app);
    refused(
      await http(missing)
        .post('/api/admin/label-templates')
        .send({ name: uniqueName(), layout: layout(artwork.id) }),
      MISSING,
    );
    refused(
      await http(missing)
        .post(`/api/admin/label-templates/${version.templateId}/versions`)
        .send({ layout: layout(artwork.id, { widthMm: 70, heightMm: 110 }) }),
      MISSING,
    );
    refused(
      await http(missing).get(
        `/api/admin/label-template-versions/${version.versionId}/calibration.pdf`,
      ),
      MISSING,
    );
    refused(
      await http(missing).post(`/api/admin/bottle-batches/${registered.batch.code}/print-jobs`),
      MISSING,
    );
    // An older, COMPLETED job: neither regenerated nor handed out.
    refused(
      await http(missing).get(`/api/admin/label-print-jobs/${registered.printJob!.code}/pdf`),
      MISSING,
    );
    refused(
      await http(missing).post(`/api/admin/label-print-jobs/${registered.printJob!.code}/generate`),
      MISSING,
    );
    refused(
      await http(missing)
        .post('/api/admin/crate-label-print-jobs')
        .send({ requestId: randomUUID(), crateCodes: [crateCode], widthMm: 70, heightMm: 40 }),
      MISSING,
    );
    refused(
      await http(missing).get(`/api/admin/crate-label-print-jobs/${crateJob.code}/pdf`),
      MISSING,
    );
    refused(
      await http(missing).post(`/api/admin/crate-label-print-jobs/${crateJob.code}/generate`),
      MISSING,
    );
    refused(
      await http(missing).get(
        `/api/admin/crate-label-preview?widthMm=70&heightMm=40&crateType=${crateType.code}`,
      ),
      MISSING,
    );
    refused(
      await http(missing).get(
        `/api/admin/workstations/${station.code}/qr-label?widthMm=70&heightMm=40`,
      ),
      MISSING,
    );
    // The refused jobs kept their state.
    expect(
      (await http(missing).get(`/api/admin/label-print-jobs/${registered.printJob!.code}`)).body,
    ).toMatchObject({ status: 'COMPLETED', attempts: 1 });
  });

  it('a refused registration creates nothing; the same request later creates everything once', async () => {
    const body = {
      requestId: randomUUID(),
      labelTemplateVersionId: version.versionId,
      quantity: 3,
    };
    const before = await missing.prisma.bottle.count();
    const jobsBefore = await missing.prisma.labelPrintJob.count();
    refused(
      await http(missing).post('/api/admin/bottle-registrations').send(body),
      'QR_LABEL_SETTINGS_MISSING',
    );
    expect(await missing.prisma.bottle.count()).toBe(before);
    expect(await missing.prisma.labelPrintJob.count()).toBe(jobsBefore);

    const first = (
      await http(configured).post('/api/admin/bottle-registrations').send(body).expect(201)
    ).body as BottleRegistrationResponse;
    expect(first).toMatchObject({ replayed: false, batch: { quantityCreated: 3 } });
    expect(first.printJob).toMatchObject({ status: 'PENDING', qrErrorCorrection: 'Q' });
    const replay = (await http(configured).post('/api/admin/bottle-registrations').send(body))
      .body as BottleRegistrationResponse;
    expect(replay).toMatchObject({ replayed: true, printJob: { code: first.printJob!.code } });
    expect(await missing.prisma.bottle.count()).toBe(before + 3);
    expect(await missing.prisma.labelPrintJob.count()).toBe(jobsBefore + 1);
  });

  it('a job made with another error correction, or below a raised minimum, is never printed', async () => {
    refused(
      await http(changedLevel).get(`/api/admin/label-print-jobs/${registered.printJob!.code}/pdf`),
      'QR_LABEL_SETTINGS_CHANGED',
    );
    refused(
      await http(changedLevel).post(`/api/admin/crate-label-print-jobs/${crateJob.code}/generate`),
      'QR_LABEL_SETTINGS_CHANGED',
    );
    // The template's QR is 15 mm, the crate label's 30 mm: below a 40 mm minimum.
    refused(
      await http(largerMinimum).get(`/api/admin/label-print-jobs/${registered.printJob!.code}/pdf`),
      'QR_LABEL_TOO_SMALL',
    );
    refused(
      await http(largerMinimum).get(`/api/admin/crate-label-print-jobs/${crateJob.code}/pdf`),
      'QR_LABEL_TOO_SMALL',
    );
  });

  it('with valid settings our labels are created and printed as before', async () => {
    const job = (
      await http(configured)
        .post(`/api/admin/bottle-batches/${registered.batch.code}/print-jobs`)
        .expect(201)
    ).body as LabelPrintJob;
    const done = (
      await http(configured).post(`/api/admin/label-print-jobs/${job.code}/generate`).expect(200)
    ).body as LabelPrintJob;
    expect(done.status).toBe('COMPLETED');
    await http(configured).get(done.downloadUrl!).expect(200);
    await http(configured)
      .get(`/api/admin/crate-label-print-jobs/${crateJob.code}/pdf`)
      .expect(200);
    await http(configured)
      .get(`/api/admin/workstations/${station.code}/qr-label?widthMm=70&heightMm=40`)
      .expect(200);
    await http(configured)
      .get(`/api/admin/label-template-versions/${version.versionId}/calibration.pdf`)
      .expect(200);
  });
});
