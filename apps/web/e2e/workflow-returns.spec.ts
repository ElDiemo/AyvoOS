import { expect, test, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * Příjem vratek R1 (doc 047 §4.9) on the real built app with synthetic data and the FAKE test
 * carrier: two crates delivered by SIMULATED carrier events (written into the recreated e2e
 * database only, PPL code 450), then the intake through the UI — crate K scanned back, its
 * bottle and a bottle of crate L (still delivered) identified in K, an unreadable piece, a
 * defective pump, the physical count, Vyprázdněno and the close — at 390 px and 1440 px.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

let orderCode = '';
const crates: { url: string; code: string; bottles: string[] }[] = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `returns-mydlo-${Date.now()}`, 4);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (vratky E2E)',
  });
  // Weights for the carrier's parcels (doc 025 §10), as the dispatch specs do.
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '10'))!;
  await receiveStock(request, kit.pumpCode, '10');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '3000'))!,
  );
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
    crates.push({ ...crate, bottles: urls });
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Vratky (E2E)',
          addressLine1: 'Wilsonova 5',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 777',
          contactEmail: 'recepce@vratky.test',
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
  // SIMULATED carrier: both parcels delivered (PPL 450), then the real tracking derives the states.
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            450, 'Delivered', NULL, NULL, 'Zásilku jsme doručili příjemci.', 'DELIVERED', now(), now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${orderCode}' AND s."status" = 'LABELED'
     ON CONFLICT DO NOTHING`,
  ]);
  await json(
    await request.post(`/api/admin/orders/${orderCode}/shipment/tracking/refresh`, {
      data: { requestId: crypto.randomUUID() },
    }),
  );
  const order = await json<{ status: string }>(await request.get(`/api/admin/orders/${orderCode}`));
  expect(order.status).toBe('DELIVERED');
  await context.close();
});

async function scanBottle(page: Page, line: string, url: string, defective = false) {
  const card = page.getByTestId(line);
  if (defective) await card.getByLabel('Vadná → ke skartaci').check();
  else await card.getByLabel('Dobrá → čeká na mytí').check();
  await card.getByRole('textbox', { name: /Naskenujte lahev/ }).fill(url);
  await card.getByRole('button', { name: 'Zapsat lahev' }).click();
}

for (const width of [390, 1440] as const) {
  test(`intake at ${width} px: a mixed return, an unreadable piece, Vyprázdněno and the close`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const [k, l] = crates as [(typeof crates)[number], (typeof crates)[number]];
    await page.goto('/warehouse/returns');
    await expect(page.getByRole('heading', { name: 'Příjem vratek' })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', { name: 'Otevřít příjem' }).click();
    await expect(page).toHaveURL(/\/warehouse\/returns\/RR-\d{6}$/);
    await expect(page.getByTestId('receipt-state')).toContainText('Otevřený');

    if (width === 390) {
      // Crate K back; K's bottle good, then L's bottle defective — found in K's container.
      await page.getByRole('textbox', { name: 'Naskenujte vrácenou bednu' }).fill(k.url);
      await page.getByRole('button', { name: 'Přidat bednu' }).click();
      await expect(page.getByTestId('return-message')).toContainText(`Bedna ${k.code} přijata`);
      const line = `return-line-${k.code}`;
      await scanBottle(page, line, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('Vrácená, čeká na mytí');
      await scanBottle(page, line, l.bottles[0]!, true);
      await expect(page.getByTestId('return-message')).toContainText('Ke skartaci');
      // The same bottle again: the first result, nothing doubled.
      await scanBottle(page, line, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('už zapsáno');
      await page.getByTestId(line).getByRole('button', { name: 'Nečitelná lahev +1' }).click();
      await expect(page.getByTestId('return-message')).toContainText('Nečitelná lahev');
      await page.getByRole('button', { name: 'Vadná pumpička −1' }).click();
      await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 1');
      const card = page.getByTestId(line);
      await expect(card.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 3');
      await expect(card.getByTestId('line-history')).toContainText('bez potvrzeného návratu 1');
      await noOverflow(page);
      await card.getByRole('textbox', { name: /Fyzicky vyjmuto/ }).fill('3');
      await card.getByRole('button', { name: 'Vyprázdněno' }).click();
      await expect(card.getByTestId('line-recorded')).toContainText('Vyprázdněno · fyzicky 3 ks');
      await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
      // The unreadable piece stays an open issue that can still be resolved after the close.
      await expect(card.getByTestId('line-issues')).toContainText('Nečitelná lahev');
    } else {
      // Crate L (still delivered, one bottle already identified in K): its other bottle, a
      // container without a code, the count that differs → COUNT_MISMATCH, never a block.
      await page.getByRole('textbox', { name: 'Naskenujte vrácenou bednu' }).fill(l.url);
      await page.getByRole('button', { name: 'Přidat bednu' }).click();
      const line = `return-line-${l.code}`;
      await scanBottle(page, line, l.bottles[1]!);
      await expect(page.getByTestId('return-message')).toContainText('Vrácená, čeká na mytí');
      // A bottle already received elsewhere is refused for this line.
      await scanBottle(page, line, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('přijata jinde');
      const card = page.getByTestId(line);
      await expect(card.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 1');
      await card.getByRole('textbox', { name: /Fyzicky vyjmuto/ }).fill('2');
      await card.getByRole('button', { name: 'Vyprázdněno' }).click();
      await expect(card.getByTestId('line-issues')).toContainText('Nesouhlasí počet kusů');
      await expect(card.getByTestId('line-issues')).toContainText('fyzicky 2, zaznamenáno 1');
      await noOverflow(page);
      await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
      // The overview: K's and L's good bottles wait for washing.
      await page.goto('/warehouse/returns');
      await expect(page.getByTestId('waiting-for-wash').locator('li')).toHaveCount(2);
      await expect(page.getByTestId('open-issues')).toContainText('Nečitelná lahev');
      await noOverflow(page);
    }
  });
}
