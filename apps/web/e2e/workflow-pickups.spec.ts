import { expect, test } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * Expedice → Svoz (doc 029 §11) on the real built app with synthetic data and the FAKE test carrier
 * (CARRIER_PROVIDER=test, APP_ENV=test only): an order ready for pickup is planned, the day and a
 * wished window are chosen, the parcel sum is shown, and one confirmed "Objednat svoz PPL" orders
 * the pickup. The pickup never moves the order: it stays "Připravená k vyzvednutí". Phone widths
 * without horizontal scrolling. Nothing here talks to PPL.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

let orderCode = '';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `pickup-mydlo-${Date.now()}`, 4);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (svoz E2E)',
  });
  await json(
    await request.post(`/api/admin/catalog/products/${kit.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  // The parcel's calculated reference weight needs the crate's tare (the test carrier requires it).
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '10'))!;
  await receiveStock(request, kit.pumpCode, '10');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '2000'))!,
  );
  const crates: { url: string; code: string }[] = [];
  for (let i = 0; i < 2; i++) {
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
    crates.push(crate);
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Svoz (E2E)',
          addressLine1: 'Wilsonova 5',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 777',
          contactEmail: 'recepce@svoz.test',
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
          lines: [{ productCode: kit.productCode, crates: 2 }],
        },
      }),
    )
  ).code;
  for (const c of crates) {
    await json(
      await request.post(`/api/admin/orders/${orderCode}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
  }
  await json(
    await request.post(`/api/admin/orders/${orderCode}/complete-and-label`, {
      data: { requestId: crypto.randomUUID(), printerId: null },
    }),
  );
  await json(
    await request.post(`/api/admin/orders/${orderCode}/shipment/ready`, {
      data: { requestId: crypto.randomUUID(), labelsApplied: true },
    }),
  );
  await context.close();
});

test('svoz: the ready order selected, one confirmed pickup order; the order is not handed over', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dispatch/pickups');
  await expect(page.getByTestId('pickup-environment').first()).toContainText('Testovací prostředí');
  const mine = page.getByTestId(`pickup-select-${orderCode}`);
  // Every eligible order is selected by default; only this spec's order is ordered here.
  await expect(mine).toBeChecked();
  for (const box of await page.locator('[data-testid^="pickup-select-"]').all()) {
    if ((await box.getAttribute('data-testid')) !== `pickup-select-${orderCode}`) {
      if ((await box.isEnabled()) && (await box.isChecked())) await box.uncheck();
    }
  }
  await expect(page.getByTestId('pickup-total')).toHaveText('Vybráno 1 obj., 2 balíků');
  await page.getByTestId('pickup-from').fill('13:00');
  await page.getByTestId('pickup-to').fill('16:00');
  await noOverflow(page);

  await page.getByTestId('pickup-order').click();
  const dialog = page.getByTestId('pickup-confirm');
  await expect(dialog).toContainText('vyzvedl 2 balíků');
  // The explicit check box first.
  await expect(dialog.getByRole('button', { name: 'Objednat svoz' })).toBeDisabled();
  await dialog.getByTestId('pickup-confirm-check').check();
  await dialog.getByRole('button', { name: 'Objednat svoz' }).click();

  const history = page.getByTestId('pickup-history');
  const item = history.locator('[data-testid^="pickup-SV-"]').first();
  await expect(item).toContainText('Potvrzeno dopravcem');
  await expect(item).toContainText('13:00–16:00');
  await expect(item).toContainText(`${orderCode}`);
  await expect(item).toContainText('čeká na předání');
  // Planned now: not offered again for a coming pickup.
  await expect(mine).toBeDisabled();
  await expect(page.getByText(/Ve svozu SV-/).first()).toBeVisible();
  await expect(item).toContainText('balík 1');
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow(page);

  // "Zrušit svoz": one request, confirmed by the (test) carrier — the parcels are free again, the
  // pickup and its plan stay in the history.
  await page.setViewportSize({ width: 390, height: 844 });
  const code = (await item.getAttribute('data-testid'))!.replace('pickup-', '');
  await page.getByTestId(`pickup-cancel-button-${code}`).click();
  const cancelDialog = page.getByTestId(`pickup-cancel-dialog-${code}`);
  await cancelDialog.getByRole('textbox').fill('Svoz už nepotřebujeme');
  await expect(cancelDialog.getByRole('button', { name: 'Požádat o zrušení' })).toBeDisabled();
  await page.getByTestId(`pickup-cancel-check-${code}`).check();
  await cancelDialog.getByRole('button', { name: 'Požádat o zrušení' }).click();
  await expect(page.getByTestId(`pickup-cancel-${code}`)).toContainText('Svoz zrušen dopravcem');
  await expect(mine).toBeEnabled();
  await expect(page.getByTestId(`pickup-${code}`)).toContainText(orderCode);
  await noOverflow(page);

  // The pickup is a plan, not a hand-over.
  await page.goto(`/dispatch/orders/${orderCode}`);
  await expect(page.getByTestId('order-status')).toHaveText('Připravená k vyzvednutí');
});
