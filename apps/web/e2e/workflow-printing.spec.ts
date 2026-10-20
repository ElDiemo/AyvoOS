import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * "Dokončit a vytisknout štítky" (doc 030) on the real built app with synthetic data, the FAKE test
 * carrier and a SIMULATED print agent (this spec calls the agent API like the Raspberry Pi would —
 * there is no printer): the site's printer and agent in the administration (the token shown once),
 * three crates picked on a phone, one action → three PDF + three ZPL labels and three print jobs,
 * the files per parcel and the complete A4 document, one uncertain job re-printed alone (the risk
 * of a duplicate acknowledged). Screenshots (AYVO_SCREENSHOT_DIR) never show the agent's token.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const crates: { url: string; code: string }[] = [];
let orderCode = '';
let siteId = '';
let agentToken = '';
let printerId = '';
let legacyOrder = '';
let legacyCrate: { url: string; code: string } | null = null;
const suffix = Date.now().toString(36).slice(-4).toUpperCase();

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  // Never a secret on a screenshot.
  if (agentToken) expect(await page.content()).not.toContain(agentToken);
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}
async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** The simulated Raspberry Pi. */
const agent = (request: APIRequestContext) => ({
  post: (path: string, data: object = {}) =>
    request.post(`/api/agent/v1/${path}`, {
      data,
      headers: { 'X-Ayvo-Print-Agent': agentToken },
    }),
  get: (path: string) =>
    request.get(`/api/agent/v1/${path}`, { headers: { 'X-Ayvo-Print-Agent': agentToken } }),
});
type Job = { id: string; claimToken: string };
async function claim(request: APIRequestContext): Promise<Job | null> {
  return (await json<{ job: Job | null }>(await agent(request).post('jobs/claim'))).job;
}
async function printOne(request: APIRequestContext, outcome: 'SENT' | 'UNCERTAIN') {
  const job = (await claim(request))!;
  const data = await request.get(`/api/agent/v1/jobs/${job.id}/data`, {
    headers: { 'X-Ayvo-Print-Agent': agentToken, 'X-Ayvo-Claim': job.claimToken },
  });
  expect(data.status()).toBe(200);
  expect((await data.body()).toString('latin1')).toMatch(/^\^XA/);
  await json(await agent(request).post(`jobs/${job.id}/start`, { claimToken: job.claimToken }));
  await json(
    await agent(request).post(`jobs/${job.id}/result`, {
      claimToken: job.claimToken,
      outcome,
      detail: outcome === 'UNCERTAIN' ? 'Simulace: odpověď z USB se ztratila' : null,
    }),
  );
}

async function printedBottles(request: APIRequestContext, name: string, n: number) {
  const artwork = await json<{ id: string }>(
    await request.post('/api/admin/label-artworks', {
      multipart: {
        file: {
          name: 'mydlo1.svg',
          mimeType: 'image/svg+xml',
          buffer: await readFile(resolve(import.meta.dirname, 'fixtures/mydlo1.svg')),
        },
      },
    }),
  );
  const version = await json<{ versionId: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name,
        layout: {
          artworkId: artwork.id,
          widthMm: 70,
          heightMm: 110,
          elements: [
            { type: 'QR_CODE', xMm: 27.5, yMm: 70, widthMm: 15, heightMm: 15, rotationDeg: 0 },
          ],
        },
      },
    }),
  );
  const reg = await json<{ batch: { firstBottleCode: string }; printJob: { code: string } }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: n,
      },
    }),
  );
  await json(await request.post(`/api/admin/label-print-jobs/${reg.printJob.code}/generate`));
  const first = Number(reg.batch.firstBottleCode.slice(6));
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = `AYV-B-${String(first + i).padStart(6, '0')}`;
    urls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
  return { versionId: version.versionId, urls };
}
const measurement = (extra: Record<string, unknown>) => ({
  requestId: crypto.randomUUID(),
  measuredOn: '2026-10-15',
  method: 'Plošinová váha (E2E, syntetické)',
  correctionOf: null,
  correctionReason: null,
  ...extra,
});

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `tisk-mydlo-${Date.now()}`, 8);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (tisk E2E)',
  });
  // Known reference weights: the test carrier needs a weight per parcel.
  await json(
    await request.post(`/api/admin/catalog/products/${kit.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/tare`, {
      data: measurement({ massG: '1850', configuration: 'Bedna s přepážkami' }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/dimensions`, {
      data: measurement({
        subject: 'SHIPPING_PACKAGE',
        lengthMm: 600,
        widthMm: 400,
        heightMm: 300,
        extraPackaging: 'NONE',
        extraDescription: null,
        extraMassG: null,
        extraItemCode: null,
        extraInTare: null,
      }),
    }),
  );
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  await receiveStock(request, kit.pumpCode, '20');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '5000'))!,
  );
  for (let i = 0; i < 4; i++) {
    const urls = printed.urls.slice(i * 2, i * 2 + 2);
    const crate = await labelledCrate(request, kit, {
      versionId: printed.versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, {
      liquidLotId: liquid,
      bottleUrls: urls,
      category: 'HAND_SOAP',
    });
    if (i < 3) crates.push(crate);
    else legacyCrate = crate;
  }
  siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Tisk (E2E)',
          addressLine1: 'Nádražní 7',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 777',
          contactEmail: 'recepce@tisk.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  const calendar = await json<{ today: string }>(await request.get('/api/admin/orders/calendar'));
  orderCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: calendar.today,
          lines: [{ productCode: kit.productCode, crates: 3 }],
        },
      }),
    )
  ).code;
  legacyOrder = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: calendar.today,
          lines: [{ productCode: kit.productCode, crates: 1 }],
        },
      }),
    )
  ).code;
  await context.close();
});

test('the site printer and its agent in the administration; the token is shown once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/admin/sites/${siteId}`);
  const card = page.getByTestId('site-printing');
  await expect(card).toContainText('účet dopravce není tiskárna');
  await expect(card.getByTestId('printing-summary')).toContainText('není nastavená');
  await card.getByTestId('agent-code').fill(`RPI-E2E-${suffix}`);
  await card.getByTestId('agent-name').fill('Raspberry Pi – expedice (E2E)');
  await card.getByTestId('add-agent').click();
  agentToken = (await card.getByTestId('agent-token-value').textContent())!.trim();
  expect(agentToken).toMatch(/^ayvo_pa_/);
  await card.getByTestId('agent-token-dismiss').click();
  await expect(card.getByTestId('agent-token')).toHaveCount(0);
  // After a reload the token is gone for good.
  await page.reload();
  expect(await page.content()).not.toContain(agentToken);
  await card.getByTestId('add-printer').click();
  const form = card.getByTestId('printer-form');
  await form.getByTestId('printer-code').fill(`ZD-E2E-${suffix}`);
  await form.getByTestId('printer-name').fill('Zebra expedice (E2E)');
  await form
    .getByTestId('printer-agent')
    .selectOption({ label: `Raspberry Pi – expedice (E2E) (RPI-E2E-${suffix})` });
  await form.getByTestId('printer-usb').fill(`E2E${suffix}`);
  await expect(form.getByTestId('printer-dispatchDefault')).toBeChecked();
  await form.getByTestId('printer-save').click();
  await expect(card.getByTestId(`printer-ZD-E2E-${suffix}`)).toContainText('Výchozí pro expedici');
  await expect(card.getByTestId('printing-summary')).toContainText(
    'Štítky expedice půjdou na: Zebra expedice (E2E)',
  );
  // The simulated agent reports in.
  const printing = await json<{ printers: { id: string; code: string }[] }>(
    await page.request.get(`/api/admin/sites/${siteId}/printing`),
  );
  printerId = printing.printers.find((p) => p.code === `ZD-E2E-${suffix}`)!.id;
  await json(
    await agent(page.request).post('heartbeat', {
      version: '0.1.0',
      printers: [{ printerId, state: 'READY', detail: null }],
    }),
  );
  await page.reload();
  await expect(card.getByTestId(`agent-RPI-E2E-${suffix}-online`)).toHaveText('Ozval se');
  await expect(card.getByTestId(`printer-ZD-E2E-${suffix}-state`)).toContainText('Připravena');
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'printing-01-site-printers-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'printing-01-site-printers-390');
});

test('one action completes, labels and queues three labels on the printer shown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}/pick`);
  for (const c of crates) {
    await expect(page.getByTestId('scan-input')).toBeFocused();
    await page.keyboard.type(c.url);
    await page.keyboard.press('Enter');
    await expect(page.getByText(c.code).first()).toBeVisible();
  }
  const button = page.getByTestId('complete-picking');
  await expect(button).toHaveText('Dokončit a vytisknout 3 štítky');
  await expect(page.getByTestId('print-target')).toContainText('Zebra expedice (E2E)');
  await shot(page, 'printing-02-complete-and-print-390');
  // A double tap is one action.
  await button.dblclick();
  await expect(page.getByTestId('picking-ready')).toContainText('Kompletace dokončena');
  await expect(page.getByTestId('pick-message')).toContainText('Zebra expedice (E2E)');
  await page.getByTestId('open-order').click();
  await page.waitForURL(`**/dispatch/orders/${orderCode}`);
  await expect(page.getByTestId('order-status')).toHaveText('Kompletace dokončena');
  const card = page.getByTestId('print-card');
  await expect(card.getByTestId('print-target')).toContainText('Zebra expedice (E2E)');
  for (const n of [1, 2, 3]) {
    await expect(card.getByTestId(`print-parcel-${n}-status`)).toHaveText('Čeká ve frontě');
  }
  // Files per parcel: its PDF (preview, download) and its ZPL; the complete A4 document too.
  for (const n of [1, 2, 3]) {
    const pdf = await page.request.get((await card.getByTestId(`pdf-${n}`).getAttribute('href'))!);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    const zpl = await page.request.get((await card.getByTestId(`zpl-${n}`).getAttribute('href'))!);
    expect(zpl.headers()['content-type']).toContain('application/zpl');
    const number = (await page.getByTestId(`parcel-${n}-number`).textContent())!.trim();
    expect((await zpl.body()).toString('latin1')).toContain(number);
  }
  const complete = await page.request.get(
    (await page.getByTestId('open-labels').getAttribute('href'))!,
  );
  expect(complete.headers()['content-type']).toContain('application/pdf');
  await card.getByTestId('preview-1').click();
  await expect(card.getByTestId('preview-frame-1')).toBeVisible();
  const detail = await json<{ shipment: { request: { attemptNo: number } } }>(
    await page.request.get(`/api/admin/orders/${orderCode}/shipment`),
  );
  expect(detail.shipment.request.attemptNo).toBe(1);
});

test('the simulated agent prints; an uncertain label is re-printed alone, the duplicate risk acknowledged', async ({
  page,
}) => {
  await printOne(page.request, 'SENT');
  await printOne(page.request, 'UNCERTAIN');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  const card = page.getByTestId('print-card');
  await expect(card.getByTestId('print-summary')).toContainText('Odesláno do tiskárny: 1 z 3');
  await expect(card.getByTestId('print-parcel-1-status')).toHaveText('Odesláno do tiskárny');
  await expect(card.getByTestId('print-parcel-2-status')).toHaveText(
    'Nejisté – mohlo se vytisknout',
  );
  await expect(card.getByTestId('print-parcel-3-status')).toHaveText('Čeká ve frontě');
  await shot(page, 'printing-03-order-three-parcels-queue-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'printing-03-order-three-parcels-queue-390');

  await card.getByTestId('reprint-2').click();
  const dialog = page.getByTestId('reprint-dialog-2');
  await dialog.getByRole('textbox').fill('Štítek nevyjel z tiskárny');
  await expect(dialog.getByRole('button', { name: 'Vytisknout znovu' })).toBeDisabled();
  await dialog.getByTestId('reprint-duplicate').check();
  await dialog.getByRole('button', { name: 'Vytisknout znovu' }).click();
  await expect(card.getByTestId('print-parcel-2-status')).toHaveText('Čeká ve frontě');
  // Only that label was queued again; parcel 1 stays as it was.
  await expect(card.getByTestId('print-parcel-1-status')).toHaveText('Odesláno do tiskárny');
  await printOne(page.request, 'SENT');
  await printOne(page.request, 'SENT');
  await page.reload();
  await expect(card.getByTestId('print-summary')).toContainText('Odesláno do tiskárny: 3 z 3');
  // Sent ≠ applied: the operator still confirms "Připraveno k vyzvednutí".
  await expect(page.getByTestId('order-status')).toHaveText('Kompletace dokončena');
  await expect(page.getByTestId('confirm-ready')).toBeVisible();
  await shot(page, 'printing-04-all-sent-390');
});

test('PRINT38-R2: a shipment labelled before direct printing (PDF only) prints from the order', async ({
  page,
}) => {
  const request = page.request;
  // Completed and labelled without printing…
  await json(
    await request.post(`/api/admin/orders/${legacyOrder}/crates`, {
      data: { requestId: crypto.randomUUID(), scannedValue: legacyCrate!.url },
    }),
  );
  await json(
    await request.post(`/api/admin/orders/${legacyOrder}/complete-and-label`, {
      data: { requestId: crypto.randomUUID(), printerId: null },
    }),
  );
  // …then made into the state of a shipment labelled before doc 030 (test-only): PDF, no ZPL,
  // no ZPL fetch at all.
  const shipment = `(SELECT s."id" FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id" WHERE o."code" = '${legacyOrder}' AND s."status" = 'LABELED')`;
  await e2eSql([
    'ALTER TABLE "shipment_labels" DISABLE TRIGGER "shipment_labels_immutable"',
    'ALTER TABLE "shipment_label_fetches" DISABLE TRIGGER "shipment_label_fetches_no_delete"',
    `DELETE FROM "shipment_labels" WHERE "format" = 'ZPL' AND "shipment_id" = ${shipment}`,
    `DELETE FROM "shipment_label_fetches" WHERE "shipment_id" = ${shipment}`,
    'ALTER TABLE "shipment_labels" ENABLE TRIGGER "shipment_labels_immutable"',
    'ALTER TABLE "shipment_label_fetches" ENABLE TRIGGER "shipment_label_fetches_no_delete"',
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${legacyOrder}`);
  const card = page.getByTestId('print-card');
  await expect(card.getByTestId('zpl-1')).toHaveCount(0);
  await card.getByTestId('print-all').click();
  await expect(card.getByTestId('print-parcel-1-status')).toHaveText('Čeká ve frontě');
  await page.reload();
  await expect(card.getByTestId('print-parcel-1-status')).toHaveText('Čeká ve frontě');
  await expect(card.getByTestId('zpl-1')).toBeVisible();
  const detail = await json<{
    shipment: { zpl: { status: string } | null; request: { attemptNo: number } };
  }>(await request.get(`/api/admin/orders/${legacyOrder}/shipment`));
  expect(detail.shipment.zpl?.status).toBe('DONE');
  expect(detail.shipment.request.attemptNo).toBe(1); // the same shipment, nothing new at the carrier
});
