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
/** Printed, never labelled: "not in circulation" pieces (a scan that records an issue). */
let spare: string[] = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `returns-mydlo-${Date.now()}`, 6);
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
  spare = printed.urls.slice(4);
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
      // Read later: it is K's cracked second bottle — resolved on the closed receipt as defective.
      const issue = card.getByTestId('line-issues').locator('li').filter({ hasText: 'Nečitelná' });
      await issue.getByLabel('Vadná → ke skartaci').check();
      await issue.getByRole('textbox', { name: /Dořešit naskenováním lahve/ }).fill(k.bottles[1]!);
      await issue.getByRole('button', { name: 'Dořešit' }).click();
      await expect(page.getByTestId('return-message')).toContainText('Ke skartaci');
      await expect(card.getByTestId('line-issues')).toContainText('Dořešeno identifikací');
      await expect(card.getByTestId('line-bottles')).toContainText('Ke skartaci');
      await expect(card.getByTestId('line-recorded')).toContainText('Zaznamenáno kusů: 3');
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
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
      // The unreadable piece was resolved (defective); COUNT_MISMATCH is information, not open work.
      await expect(page.getByText('Žádná otevřená neshoda.')).toBeVisible();
      await noOverflow(page);
    }
  });
}

test('a confirmed write whose refresh fails is never sent again: "Obnovit" only reads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/warehouse/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/warehouse\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/api/admin/returns/receipts/${code}/`)) {
      posts.push(new URL(r.url()).pathname.split('/').pop()!);
    }
  });
  // The next GET of the detail fails (after the POST really committed).
  let failGets = 0;
  await page.route(`**/api/admin/returns/receipts/${code}`, async (route) => {
    if (route.request().method() === 'GET' && failGets > 0) {
      failGets -= 1;
      await route.fulfill({ status: 503, body: '{"statusCode":503}' });
    } else {
      await route.continue();
    }
  });
  failGets = 1;
  await page.getByRole('button', { name: 'Krabice bez kódu' }).click();
  await expect(page.getByTestId('refresh-failed')).toBeVisible();
  // While it is not refreshed, no action can be sent again.
  await expect(page.getByRole('button', { name: 'Krabice bez kódu' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Vadná pumpička −1' })).toBeDisabled();
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('refresh-failed')).toHaveCount(0);
  await expect(page.getByTestId('return-line-box-1')).toBeVisible();
  await expect(page.getByTestId('return-line-box-2')).toHaveCount(0);

  failGets = 1;
  await page.getByRole('button', { name: 'Vadná pumpička −1' }).click();
  await expect(page.getByTestId('refresh-failed')).toBeVisible();
  await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 0');
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 1');

  failGets = 1;
  await page
    .getByTestId('return-line-box-1')
    .getByRole('button', { name: 'Nečitelná lahev +1' })
    .click();
  await expect(page.getByTestId('refresh-failed')).toBeVisible();
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('return-line-box-1').getByTestId('line-recorded')).toHaveText(
    'Zaznamenáno kusů: 1',
  );
  // Each committed once — the server agrees.
  expect(posts).toEqual(['containers', 'pumps', 'unreadable']);
  const detail = await (await page.request.get(`/api/admin/returns/receipts/${code}`)).json();
  expect([
    detail.lineDetails.length,
    detail.defectivePumps,
    detail.lineDetails[0].recordedCount,
  ]).toEqual([1, 1, 1]);
});

/** A keyboard scanner: the code typed after whatever the field holds, then Enter. */
async function scannerTypes(page: Page, field: ReturnType<Page['getByRole']>, code: string) {
  await field.focus();
  await field.press('End');
  await field.pressSequentially(code);
  await field.press('Enter');
}

test('a scanner typing the next bottle while the detail refreshes: two exact codes, never glued; an unconfirmed one is kept apart until it is repeated or dropped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/warehouse/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/warehouse\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  await page.getByRole('button', { name: 'Krabice bez kódu' }).click();
  const card = page.getByTestId('return-line-box-1');
  await expect(card).toBeVisible();
  const field = card.getByRole('textbox', { name: /Naskenujte lahev/ });
  const unconfirmed = card.getByTestId('unconfirmed-scan');
  // The bottle form's own choice (the issues of the line have theirs).
  const choice = (label: string) => card.locator('form').first().getByLabel(label);
  // Every bottle POST as sent: the whole payload.
  const sent: { scannedValue: string; outcome: string; requestId: string }[] = [];
  let holdGet = false;
  let releaseGet!: () => void;
  let lose: 'none' | 'held' | 'at-once' = 'none';
  let releasePost!: () => void;
  await page.route(`**/api/admin/returns/receipts/${code}**`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().endsWith('/bottles')) {
      sent.push(JSON.parse(req.postData()!));
      if (lose !== 'none') {
        const wait = lose === 'held';
        lose = 'none';
        // Committed by the server, the answer lost on the way back.
        expect((await route.fetch()).status()).toBe(200);
        if (wait) await new Promise<void>((r) => (releasePost = r));
        return route.fulfill({ status: 503, body: '{"statusCode":503}' });
      }
      return route.continue();
    }
    if (req.method() === 'GET' && holdGet) {
      holdGet = false;
      await new Promise<void>((r) => (releaseGet = r));
    }
    return route.continue();
  });
  const submit = card.getByRole('button', { name: 'Zapsat lahev' });
  const enter = async () => {
    await field.focus();
    await field.press('Enter');
  };

  // 1. A confirmed; the scanner types B (and Enter) while the detail is still loading.
  holdGet = true;
  await scannerTypes(page, field, spare[0]!);
  await expect(page.getByTestId('return-message')).toContainText('Lahev není v oběhu u hotelu');
  await scannerTypes(page, field, spare[1]!);
  releaseGet();
  await expect(card.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 1');
  // B alone in the field — never A+B; its Enter during the refresh sent nothing.
  await expect(field).toHaveValue(spare[1]!);
  expect(sent.map((x) => x.scannedValue)).toEqual([spare[0]]);
  await enter();
  await expect(card.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 2');
  await expect(field).toHaveValue('');

  // 2. A (good) unconfirmed while B is already typed; sending B first is held, not lost.
  lose = 'held';
  await scannerTypes(page, field, spare[0]!);
  await expect.poll(() => sent.length).toBe(3);
  const a = sent[2]!;
  await scannerTypes(page, field, spare[1]!);
  releasePost();
  await expect(unconfirmed).toContainText('Výsledek nepotvrzený');
  await expect(card.getByTestId('unconfirmed-scan-code')).toHaveText(
    `${spare[0]} · Dobrá → čeká na mytí`,
  );
  await expect(field).toHaveValue(spare[1]!);
  await submit.click();
  await expect(card.getByTestId('unconfirmed-scan-held')).toBeVisible();
  expect(sent).toHaveLength(3);
  await expect(field).toHaveValue(spare[1]!);
  // The choice changes meanwhile; the repeat carries A's ORIGINAL payload and request id.
  await choice('Vadná → ke skartaci').check();
  await unconfirmed.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unconfirmed).toHaveCount(0);
  expect(sent[3]).toEqual(a);
  expect(a.outcome).toBe('GOOD');
  // Now B goes, whole, with the current choice and its own request id.
  await choice('Dobrá → čeká na mytí').check();
  await enter();
  await expect.poll(() => sent.length).toBe(5);
  expect(sent[4]).toMatchObject({ scannedValue: spare[1], outcome: 'GOOD' });
  expect(sent[4]!.requestId).not.toBe(a.requestId);
  await expect(field).toHaveValue('');

  await expect(submit).toBeEnabled();
  // 3. A unconfirmed with the field EMPTY: A is not put back into the field; the next code is
  // typed alone, held, then sent after A is repeated.
  lose = 'at-once';
  await scannerTypes(page, field, spare[0]!);
  await expect(unconfirmed).toBeVisible();
  const a2 = sent[5]!;
  await expect(field).toHaveValue('');
  await scannerTypes(page, field, spare[1]!);
  await expect(field).toHaveValue(spare[1]!);
  await expect(card.getByTestId('unconfirmed-scan-held')).toBeVisible();
  expect(sent).toHaveLength(6);
  await unconfirmed.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unconfirmed).toHaveCount(0);
  expect(sent[6]).toEqual(a2);
  await enter();
  await expect.poll(() => sent.length).toBe(8);
  expect(sent[7]!.scannedValue).toBe(spare[1]);

  await expect(submit).toBeEnabled();
  // 4. Dropping an unconfirmed one is explicit, and then the next code goes.
  lose = 'at-once';
  await scannerTypes(page, field, spare[0]!);
  await expect(unconfirmed).toBeVisible();
  await scannerTypes(page, field, spare[1]!);
  expect(sent).toHaveLength(9);
  await unconfirmed.getByRole('button', { name: /Zahodit/ }).click();
  await expect(unconfirmed).toHaveCount(0);
  await expect(field).toHaveValue(spare[1]!);
  await enter();
  await expect.poll(() => sent.length).toBe(10);
  expect(sent[9]!.scannedValue).toBe(spare[1]);

  await expect(submit).toBeEnabled();
  // Every code went out whole; the line counts two pieces (repeats name the same pieces).
  for (const x of sent) expect([spare[0], spare[1]]).toContain(x.scannedValue);
  await expect(card.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 2');
  const detail = await (await page.request.get(`/api/admin/returns/receipts/${code}`)).json();
  expect(detail.lineDetails[0].issues.map((i: { kind: string }) => i.kind)).toEqual([
    'NOT_IN_CIRCULATION',
    'NOT_IN_CIRCULATION',
  ]);
});
