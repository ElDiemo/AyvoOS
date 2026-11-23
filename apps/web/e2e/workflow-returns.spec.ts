import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eRows, e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * Příjem vratek R1.1 (doc 047 §4.9, §6.3) on the real built app with synthetic data and the FAKE
 * test carrier: two crates delivered by SIMULATED carrier events (written into the recreated e2e
 * database only, PPL code 450), then the intake through the UI — crate K scanned back and freed
 * (no bottle confirmed), K's bottle and a bottle of crate L (never scanned) identified on their
 * own, an unreadable piece, a defective pump and the close without any count — at 390 px and
 * 1440 px. Then R2
 * "Po mytí" (doc 048 §2) of the good bottles, a repeated scan, a refused defective one, and a
 * revoked design set aside — screenshots in docs/screenshots/returns. The scan fields are
 * also driven like a keyboard scanner (codes typed into the field, never glued; unconfirmed
 * scans kept apart).
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

/** The migrated initial site of the e2e server (auth.setup.ts). */
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';
const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/returns');
let orderCode = '';
let productCode = '';
let versionId = '';
const crates: { url: string; code: string; bottles: string[] }[] = [];
/** Printed, never labelled: "not in circulation" pieces (a scan that records an issue). */
let spare: string[] = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  // 10 for the crates K–O (two each), 2 never labelled ("not in circulation" pieces).
  const printed = await printedBottles(request, `returns-mydlo-${Date.now()}`, 12);
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
  productCode = kit.productCode;
  versionId = printed.versionId;
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '12'))!;
  await receiveStock(request, kit.pumpCode, '12');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '4000'))!,
  );
  spare = printed.urls.slice(10);
  // K and L for the intake; M and N come back later for the scan series of "Po mytí", O for the
  // end of the session.
  for (let i = 0; i < 5; i++) {
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
          lines: [{ productCode: kit.productCode, crates: crates.length }],
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

async function scanBottle(page: Page, url: string, defective = false) {
  const card = page.getByTestId('return-bottle-scan');
  if (defective) await card.getByLabel('Vadná → ke skartaci').check();
  else await card.getByLabel('Dobrá → čeká na mytí').check();
  await card.getByRole('textbox', { name: /Naskenujte lahev/ }).fill(url);
  await card.getByRole('button', { name: 'Zapsat lahev' }).click();
}

async function scanCrateIn(page: Page, url: string) {
  await page.getByRole('textbox', { name: 'Naskenujte vrácenou bednu' }).fill(url);
  await page.getByRole('button', { name: 'Uvolnit bednu' }).click();
}

for (const width of [390, 1440] as const) {
  test(`intake at ${width} px: the crate freed by its scan, each bottle on its own, an unreadable piece, the close without a count`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const [k, l] = crates as [(typeof crates)[number], (typeof crates)[number]];
    await page.goto('/production/cycle/returns');
    await expect(page.getByRole('heading', { name: 'Příjem vratek' })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', { name: 'Otevřít příjem' }).click();
    await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
    await expect(page.getByTestId('receipt-state')).toContainText('Otevřený');
    const bottles = page.getByTestId('return-line-bottles');

    if (width === 390) {
      // Crate K back: freed at once, its two bottles' binding ended — none confirmed.
      await scanCrateIn(page, k.url);
      await expect(page.getByTestId('return-message')).toContainText(
        `Bedna ${k.code} přijata a uvolněna`,
      );
      const crate = page.getByTestId(`return-line-${k.code}`);
      await expect(crate.getByTestId('line-freed')).toContainText('ukončena vazba 2 lahví');
      // K's bottle good, then L's bottle defective — L itself is never scanned.
      await scanBottle(page, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('Vrácená, čeká na mytí');
      await scanBottle(page, l.bottles[0]!, true);
      await expect(page.getByTestId('return-message')).toContainText('Ke skartaci');
      // The same bottle again: the first result, nothing doubled.
      await scanBottle(page, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('už zapsáno');
      await page
        .getByTestId('return-bottle-scan')
        .getByRole('button', { name: 'Nečitelná lahev +1' })
        .click();
      await expect(page.getByTestId('return-message')).toContainText('Nečitelná lahev');
      await page.getByRole('button', { name: 'Vadná pumpička −1' }).click();
      await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 1');
      await expect(page.getByTestId('receipt-counts')).toHaveText(
        'Bedny 1 · přijaté lahve 2 (z toho ke skartaci 1) · nečitelné 1',
      );
      await expect(bottles.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 3');
      await expect(crate.getByTestId('line-history')).toContainText('bez potvrzeného návratu 1');
      await expect(page.getByRole('button', { name: 'Vyprázdněno' })).toHaveCount(0);
      await noOverflow(page);
      await page.screenshot({ path: `${SHOTS}/intake-r11-${width}.png`, fullPage: true });
      // No count, no Vyprázdněno: the receipt closes at once.
      await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
      // The unreadable piece stays an open issue that can still be resolved after the close.
      await expect(bottles.getByTestId('line-issues')).toContainText('Nečitelná lahev');
      // Read later: it is K's cracked second bottle — resolved on the closed receipt as defective.
      const issue = bottles
        .getByTestId('line-issues')
        .locator('li')
        .filter({ hasText: 'Nečitelná' });
      await issue.getByLabel('Vadná → ke skartaci').check();
      await issue.getByRole('textbox', { name: /Dořešit naskenováním lahve/ }).fill(k.bottles[1]!);
      await issue.getByRole('button', { name: 'Dořešit' }).click();
      await expect(page.getByTestId('return-message')).toContainText('Ke skartaci');
      await expect(bottles.getByTestId('line-issues')).toContainText('Dořešeno identifikací');
      await expect(bottles.getByTestId('line-bottles')).toContainText('Ke skartaci');
      await expect(bottles.getByTestId('line-recorded')).toContainText('Zaznamenáno kusů: 3');
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
    } else {
      // Crate L (one bottle already received): freed with its one remaining binding; its other
      // bottle on its own; a bottle already received in another receipt is refused.
      await scanCrateIn(page, l.url);
      await expect(
        page.getByTestId(`return-line-${l.code}`).getByTestId('line-freed'),
      ).toContainText('ukončena vazba 1 lahve');
      await scanBottle(page, l.bottles[1]!);
      await expect(page.getByTestId('return-message')).toContainText('Vrácená, čeká na mytí');
      await scanBottle(page, k.bottles[0]!);
      await expect(page.getByTestId('return-message')).toContainText('přijata v jiném příjmu');
      await expect(bottles.getByTestId('line-recorded')).toHaveText('Zaznamenáno kusů: 1');
      await noOverflow(page);
      await page.screenshot({ path: `${SHOTS}/intake-r11-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Uzavřít příjem' }).click();
      await expect(page.getByTestId('receipt-state')).toContainText('Uzavřený');
      // The overview: K's and L's good bottles wait for washing.
      await page.goto('/production/cycle/returns');
      await expect(page.getByTestId('waiting-for-wash').locator('li')).toHaveCount(2);
      // The unreadable piece was resolved (defective): no open work left.
      await expect(page.getByText('Žádná otevřená neshoda.')).toBeVisible();
      await noOverflow(page);
    }
  });
}

test('an R1 crate answer replayed after the upgrade (no `freed`): a neutral confirmation and the next step, never "uvolněna … undefined"; freed 0 still says freed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  // The API returns the stored R1 answer of a replayed request id unchanged (returns.e2e).
  let answer: object = {
    outcome: 'CRATE_RETURNED',
    lineId: '00000000-0000-4000-8000-000000000001',
    crateCode: 'AYV-C-R1',
    orderCode: 'ORD-R1',
  };
  await page.route(`**/api/admin/returns/receipts/${code}/crates`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }),
  );
  const message = page.getByTestId('return-message');
  await scanCrateIn(page, crates[0]!.url);
  await expect(message).toContainText(
    'Bedna AYV-C-R1 (objednávka ORD-R1) už je v tomto příjmu zapsaná – nic nového se nezapsalo.',
  );
  await expect(message).toContainText('čeká-li na „Vyprázdněno“, potvrďte ho tam');
  await expect(message).not.toContainText('undefined');
  await expect(message).not.toContainText('uvolněna');
  await page.screenshot({ path: `${SHOTS}/intake-r1-replay-390.png`, fullPage: true });
  // A new answer always carries `freed` — also 0 — and says the crate was freed.
  answer = { ...answer, crateCode: 'AYV-C-NEW', freed: 0 };
  await scanCrateIn(page, crates[0]!.url);
  await expect(message).toContainText('Bedna AYV-C-NEW přijata a uvolněna');
  await expect(message).toContainText('ukončena vazba 0 lahví');
});

test('an uncertain answer of a plain button (Otevřít příjem) promises no "Zkusit znovu" it does not have; the same button again is the same request', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/production/cycle/returns');
  const ids: string[] = [];
  await page.route('**/api/admin/returns/receipts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    // The first answer is lost (as a gateway error); the second reaches the API.
    if (ids.length === 1) return route.fulfill({ status: 502, body: 'Bad gateway' });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  // (Next's route announcer is an empty alert of its own.)
  const alert = page.getByRole('alert').filter({ hasText: /\S/ });
  await expect(alert).toHaveText(
    'Spojení selhalo – výsledek není jistý. Stránku neobnovujte a zopakujte na ní stejnou akci – odešle se tentýž požadavek a nezapíše se dvakrát. Změnil-li se mezitím počet v přehledu, výsledek zůstává nejistý: akci už neopakujte, mohla by se zapsat podruhé.',
  );
  await expect(alert).not.toContainText('Zkusit znovu');
  await expect(page.getByRole('button', { name: 'Zkusit znovu' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/intake-open-uncertain-390.png`, fullPage: true });
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test('a counted action (Nečitelná lahev +1) whose answer was lost: the same button on the same page is the same request, counted once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  const ids: string[] = [];
  await page.route(`**/api/admin/returns/receipts/${code}/unreadable`, async (route) => {
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    // The first one reaches the server and is written; only its answer is lost.
    const answer = await route.fetch();
    if (ids.length === 1) return route.fulfill({ status: 502, body: 'Bad gateway' });
    return route.fulfill({ response: answer });
  });
  const add = page
    .getByTestId('return-bottle-scan')
    .getByRole('button', { name: 'Nečitelná lahev +1' });
  await add.click();
  const message = page.getByTestId('return-message');
  await expect(message).toContainText('Stránku neobnovujte a zopakujte na ní stejnou akci');
  await expect(message).toContainText(
    'Změnil-li se mezitím počet v přehledu, výsledek zůstává nejistý: akci už neopakujte',
  );
  await expect(page.getByTestId('receipt-counts')).toContainText('nečitelné 0');
  await add.click();
  await expect(message).toContainText('Nečitelná lahev');
  await expect(page.getByTestId('receipt-counts')).toContainText('nečitelné 1');
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  // A reload gives a new request id; the count alone never proves whose write it was, so the
  // text tells the user to stop repeating once the count changed.
  await page.reload();
  await expect(page.getByTestId('receipt-counts')).toContainText('nečitelné 1');
});

test('a confirmed write whose refresh fails is never sent again: "Obnovit" only reads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
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
  const unreadable = page
    .getByTestId('return-bottle-scan')
    .getByRole('button', { name: 'Nečitelná lahev +1' });
  failGets = 1;
  await unreadable.click();
  await expect(page.getByTestId('refresh-failed')).toBeVisible();
  // While it is not refreshed, no action can be sent again.
  await expect(unreadable).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Vadná pumpička −1' })).toBeDisabled();
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('refresh-failed')).toHaveCount(0);
  await expect(page.getByTestId('return-line-bottles').getByTestId('line-recorded')).toHaveText(
    'Zaznamenáno kusů: 1',
  );

  failGets = 1;
  await page.getByRole('button', { name: 'Vadná pumpička −1' }).click();
  await expect(page.getByTestId('refresh-failed')).toBeVisible();
  await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 0');
  await page.getByTestId('refresh-failed').getByRole('button', { name: 'Obnovit' }).click();
  await expect(page.getByTestId('pump-count')).toHaveText('Vadné pumpičky: 1');

  // Each committed once — the server agrees.
  expect(posts).toEqual(['unreadable', 'pumps']);
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
  await page.goto('/production/cycle/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  const card = page.getByTestId('return-bottle-scan');
  await expect(card).toBeVisible();
  const recorded = page.getByTestId('return-line-bottles').getByTestId('line-recorded');
  const field = card.getByRole('textbox', { name: /Naskenujte lahev/ });
  const unconfirmed = card.getByTestId('unconfirmed-scan');
  // The bottle form's own choice (the issues of the BOTTLES line have theirs).
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
  await expect(recorded).toHaveText('Zaznamenáno kusů: 1');
  // B alone in the field — never A+B; its Enter during the refresh sent nothing.
  await expect(field).toHaveValue(spare[1]!);
  expect(sent.map((x) => x.scannedValue)).toEqual([spare[0]]);
  await enter();
  await expect(recorded).toHaveText('Zaznamenáno kusů: 2');
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
  await expect(recorded).toHaveText('Zaznamenáno kusů: 2');
  const detail = await (await page.request.get(`/api/admin/returns/receipts/${code}`)).json();
  expect(detail.lineDetails[0].issues.map((i: { kind: string }) => i.kind)).toEqual([
    'NOT_IN_CIRCULATION',
    'NOT_IN_CIRCULATION',
  ]);
});

type Crate = (typeof crates)[number];

/** Crates received back through the intake API, every bottle good (RETURNED). */
async function receiveBack(page: Page, back: Crate[]) {
  const receipt = await json<{ code: string }>(
    await page.request.post('/api/admin/returns/receipts', {
      data: { requestId: crypto.randomUUID(), hotelCode: null },
    }),
  );
  for (const c of back) {
    await json(
      await page.request.post(`/api/admin/returns/receipts/${receipt.code}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
    for (const url of c.bottles) {
      await json(
        await page.request.post(`/api/admin/returns/receipts/${receipt.code}/bottles`, {
          data: { requestId: crypto.randomUUID(), scannedValue: url, outcome: 'GOOD' },
        }),
      );
    }
  }
}

/** Status and number of REUSE_READY events of each bottle (by its QR URL), from the database. */
async function reuseState(urls: string[]) {
  const tokens = urls.map((u) => u.split('/').pop()!);
  const rows = await e2eRows<{ token: string; status: string; events: number }>(
    `SELECT b."public_token" AS "token", b."status"::text AS "status",
            (SELECT count(*)::int FROM "bottle_events" e WHERE e."bottle_id" = b."id" AND e."type" = 'REUSE_READY') AS "events"
       FROM "bottles" b WHERE b."public_token" IN (${tokens.map((x) => `'${x}'`).join(',')})`,
  );
  return urls.map((u) => {
    const r = rows.find((x) => x.token === u.split('/').pop())!;
    return [r.status, r.events];
  });
}

async function wash(page: Page, url: string) {
  await page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ }).fill(url);
  await page.getByRole('button', { name: 'Po mytí – připravit k plnění' }).click();
}

for (const width of [390, 1440] as const) {
  test(`"Po mytí" at ${width} px: the second scan after washing, the queue`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const [k, l] = crates as [(typeof crates)[number], (typeof crates)[number]];
    await page.goto('/production/cycle/after-wash');
    await expect(page.getByRole('heading', { name: 'Po mytí', exact: true })).toBeVisible();
    await noOverflow(page);
    const message = page.getByTestId('after-wash-message');
    if (width === 390) {
      // Both good bottles of the intake wait for washing.
      await expect(page.getByTestId('after-wash-waiting').locator('li')).toHaveCount(2);
      await page.screenshot({ path: `${SHOTS}/after-wash-queue-390.png`, fullPage: true });
      // K's good bottle, washed and inspected: ready for reuse, the same QR.
      await wash(page, k.bottles[0]!);
      await expect(message).toContainText('Připravená k plnění · Po mytí');
      await expect(page.getByTestId('after-wash-ready').locator('li')).toHaveCount(1);
      await expect(page.getByTestId('after-wash-waiting').locator('li')).toHaveCount(1);
      await page.screenshot({ path: `${SHOTS}/after-wash-ready-390.png`, fullPage: true });
      // K's other bottle was defective (Ke skartaci): refused, nothing written.
      await wash(page, k.bottles[1]!);
      await expect(message).toContainText('Lahev nečeká na mytí');
      await expect(page.getByTestId('after-wash-ready').locator('li')).toHaveCount(1);
      await noOverflow(page);
      await page.screenshot({ path: `${SHOTS}/after-wash-refused-390.png`, fullPage: true });
    } else {
      // The same bottle again: the first result, nothing doubled.
      await wash(page, k.bottles[0]!);
      await expect(message).toContainText('už je po mytí');
      await expect(page.getByTestId('after-wash-ready').locator('li')).toHaveCount(1);
      await page.screenshot({ path: `${SHOTS}/after-wash-repeated-1440.png`, fullPage: true });
      // The product's design is revoked: L's good bottle is set aside, its scan refused.
      const approvals = await json<{ id: string; revokedAt: string | null }[]>(
        await page.request.get(`/api/admin/catalog/products/${productCode}/label-approvals`),
      );
      const open = approvals.find((a) => a.revokedAt === null)!;
      await json(
        await page.request.post(
          `/api/admin/catalog/products/${productCode}/label-approvals/${open.id}/revoke`,
          { data: { requestId: crypto.randomUUID(), reason: 'E2E design stažen' } },
        ),
      );
      await page.reload();
      await expect(page.getByTestId('after-wash-withdrawn').locator('li')).toHaveCount(1);
      await expect(page.getByText('Žádná lahev nečeká na mytí.')).toBeVisible();
      await wash(page, l.bottles[1]!);
      await expect(message).toContainText('vyčleněná (odvolaná etiketa)');
      await expect(page.getByTestId('after-wash-withdrawn').locator('li')).toHaveCount(1);
      await noOverflow(page);
      await page.screenshot({ path: `${SHOTS}/after-wash-withdrawn-1440.png`, fullPage: true });
      // The washed bottle's detail: the new status and event; still one completed return.
      const code = (await page
        .getByTestId('after-wash-ready')
        .locator('li span')
        .first()
        .textContent())!;
      await page.goto(`/bottles/${code.trim()}`);
      await expect(page.getByText('Připravená k plnění · Po mytí').first()).toBeVisible();
      await expect(page.getByText('Po mytí – připravena k dalšímu plnění')).toBeVisible();
      // Its return receipt link leads into Výroba → Oběh lahví (owner 2026-11-09).
      await page.getByRole('link', { name: /^RR-\d{6}$/ }).click();
      await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Příjem vratek RR-');
    }
  });
}

test('"Po mytí": a bottle scanned while an answer is pending is kept; an uncertain answer is resent as the same request', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const [, , m, n] = crates as [
    (typeof crates)[number],
    (typeof crates)[number],
    (typeof crates)[number],
    (typeof crates)[number],
  ];
  // The design revoked above is approved again; M and N are received back, all good (API).
  await json(
    await page.request.post(`/api/admin/catalog/products/${productCode}/label-approvals`, {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: versionId,
        reason: 'E2E znovu',
      },
    }),
  );
  const receipt = await json<{ code: string }>(
    await page.request.post('/api/admin/returns/receipts', {
      data: { requestId: crypto.randomUUID(), hotelCode: null },
    }),
  );
  for (const c of [m, n]) {
    await json(
      await page.request.post(`/api/admin/returns/receipts/${receipt.code}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
    for (const url of c.bottles) {
      await json(
        await page.request.post(`/api/admin/returns/receipts/${receipt.code}/bottles`, {
          data: { requestId: crypto.randomUUID(), scannedValue: url, outcome: 'GOOD' },
        }),
      );
    }
  }
  const tokens = [...m.bottles, ...n.bottles].map((u) => u.split('/').pop()!);
  const reuseReady = async () =>
    (
      await e2eRows<{ token: string; status: string; events: number }>(
        `SELECT b."public_token" AS "token", b."status"::text AS "status",
                (SELECT count(*)::int FROM "bottle_events" e WHERE e."bottle_id" = b."id" AND e."type" = 'REUSE_READY') AS "events"
           FROM "bottles" b WHERE b."public_token" IN (${tokens.map((x) => `'${x}'`).join(',')})`,
      )
    ).reduce<Record<string, [string, number]>>(
      (all, r) => ({ ...all, [r.token]: [r.status, r.events] }),
      {},
    );

  // Every POST of a scan, with its requestId; the first one held, a later one made uncertain.
  const posts: { scanned: string; requestId: string }[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let mode: 'hold' | 'uncertain' | 'pass' = 'hold';
  await page.route('**/api/admin/returns/after-wash', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData()!) as { scannedValue: string; requestId: string };
    posts.push({ scanned: body.scannedValue, requestId: body.requestId });
    if (mode === 'hold') {
      mode = 'pass';
      await held;
      return route.continue();
    }
    if (mode === 'uncertain') {
      // The server commits, the answer is lost on the way back.
      mode = 'pass';
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      return route.fulfill({ status: 503, body: '{"statusCode":503}' });
    }
    return route.continue();
  });

  await page.goto('/production/cycle/after-wash');
  const field = page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ });
  // The first scan is sent and held; the second is scanned before its answer.
  await field.fill(m.bottles[0]!);
  await field.press('Enter');
  await expect.poll(() => posts.length).toBe(1);
  await expect(field).toHaveValue('');
  await field.fill(m.bottles[1]!);
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('after-wash-scans-unresolved')).toContainText('Čeká na odeslání');
  expect(posts).toHaveLength(1);
  release();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  expect(posts.map((p) => p.scanned)).toEqual([m.bottles[0], m.bottles[1]]);
  await page.screenshot({ path: `${SHOTS}/after-wash-series-390.png`, fullPage: true });

  // An uncertain answer stops the series; the next scan waits; "Zkusit znovu" sends the SAME request.
  mode = 'uncertain';
  await field.fill(n.bottles[0]!);
  await field.press('Enter');
  await expect(page.getByTestId('after-wash-scans-unresolved')).toContainText(
    'Výsledek posledního skenu není jistý',
  );
  await field.fill(n.bottles[1]!);
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(page.getByTestId('after-wash-scans-waiting')).toHaveText('Čeká na odeslání: 1');
  expect(posts).toHaveLength(3);
  await page.screenshot({ path: `${SHOTS}/after-wash-uncertain-390.png`, fullPage: true });
  await page
    .getByTestId('after-wash-scans-unresolved')
    .getByRole('button', { name: 'Zkusit znovu' })
    .click();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  expect(posts.map((p) => p.scanned)).toEqual([
    m.bottles[0],
    m.bottles[1],
    n.bottles[0],
    n.bottles[0],
    n.bottles[1],
  ]);
  expect(posts[3]!.requestId).toBe(posts[2]!.requestId);
  expect(new Set(posts.map((p) => p.requestId)).size).toBe(4);
  // Each of the four bottles exactly once.
  const after = await reuseReady();
  for (const token of tokens) expect(after[token]).toEqual(['READY_FOR_REUSE', 1]);
  await noOverflow(page);
});

test('"Po mytí": a refused bottle stays visible with its reason when the next scan of the series succeeds (409 → 200)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const [k, l] = crates as [Crate, Crate];
  // K's second bottle was defective (Ke skartaci); L's second one waits (its design approved again).
  expect(await reuseState([k.bottles[1]!, l.bottles[1]!])).toEqual([
    ['RETIRED', 0],
    ['RETURNED', 0],
  ]);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route('**/api/admin/returns/after-wash', async (route) => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  await page.goto('/production/cycle/after-wash');
  const field = page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ });
  await field.fill(k.bottles[1]!);
  await field.press('Enter');
  await field.fill(l.bottles[1]!);
  await field.press('Enter');
  release();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  // The last answer (200) is the current message; the refusal (409) is still listed.
  await expect(page.getByTestId('after-wash-message')).toContainText(
    'Připravená k plnění · Po mytí',
  );
  const refusals = page.getByTestId('after-wash-refusals');
  await expect(refusals.locator('li')).toHaveCount(1);
  await expect(refusals.locator('li')).toContainText(/AYV-B-\d{6}: Lahev nečeká na mytí/);
  expect(await reuseState([k.bottles[1]!, l.bottles[1]!])).toEqual([
    ['RETIRED', 0],
    ['READY_FOR_REUSE', 1],
  ]);
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/after-wash-refusal-kept-390.png`, fullPage: true });
});

test('"Po mytí": reads of the queue are merged — at most one at a time, one more after the series', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const [, , m, n] = crates as [Crate, Crate, Crate, Crate];
  const log: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseReads!: () => void;
  let reads = new Promise<void>((r) => (releaseReads = r));
  let holding = false;
  await page.goto('/production/cycle/after-wash');
  await page.route('**/api/admin/returns/after-wash', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push('GET');
      if (holding) await reads;
      const r = await route.fetch();
      inFlight -= 1;
      return route.fulfill({ response: r });
    }
    const r = await route.fetch();
    log.push('POST');
    return route.fulfill({ response: r });
  });
  // Six confirmed scans (already "Po mytí": each answers 200 with the first result) while the
  // first read is held.
  holding = true;
  const field = page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ });
  const six = [...m.bottles, ...n.bottles, m.bottles[0]!, n.bottles[0]!];
  for (const url of six) {
    await field.fill(url);
    await field.press('Enter');
  }
  await expect.poll(() => log.filter((x) => x === 'POST').length).toBe(6);
  expect(inFlight).toBe(1);
  holding = false;
  releaseReads();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  await expect.poll(() => inFlight).toBe(0);
  // One read held during the series, exactly one more after it; never two at once.
  expect(maxInFlight).toBe(1);
  expect(log.filter((x) => x === 'GET')).toHaveLength(2);
  expect(log.at(-1)).toBe('GET');
  await expect(page.getByTestId('after-wash-message')).toContainText('už je po mytí');
  reads = Promise.resolve();
});

test('"Po mytí": the end of the session stops the series and keeps the unsent scans for the same user at the same site only', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const o = crates[4]!;
  await receiveBack(page, [o]);
  expect(await reuseState(o.bottles)).toEqual([
    ['RETURNED', 0],
    ['RETURNED', 0],
  ]);
  // Another user with "Po mytí" at the same site (a custom role granted by the administrator).
  const washerEmail = `e2e-washer-${Date.now()}@ayvo.test`;
  await json(
    await page.request.post('/api/admin/identity/roles', {
      data: {
        code: `E2E_WASH_${Date.now() % 100000}`,
        name: 'Myčka (E2E)',
        description: 'Po mytí',
        permissions: ['returns:receive'],
        copiedFrom: null,
        reason: 'end-to-end washer',
      },
    }),
  ).then(async (role) => {
    const user = await json<{ id: string }>(
      await page.request.post('/api/admin/identity/users', {
        data: {
          email: washerEmail,
          displayName: 'E2E Myčka',
          roles: ['WAREHOUSE_SUPERVISOR'],
          siteIds: [INITIAL_SITE_ID],
          warehouseCodes: [],
          reason: 'end-to-end washer',
        },
      }),
    );
    await json(
      await page.request.post(`/api/admin/identity/users/${user.id}/roles/grant`, {
        data: { role: (role as { code: string }).code, reason: 'end-to-end washer' },
      }),
    );
  });

  const posts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let expire = true;
  await page.route('**/api/admin/returns/after-wash', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    posts.push((JSON.parse(req.postData()!) as { requestId: string }).requestId);
    if (expire) {
      // The session ends while the first scan is under way (nothing reaches the server).
      expire = false;
      await held;
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 401, code: 'SESSION_EXPIRED', message: 'expired' }),
      });
    }
    return route.continue();
  });
  // Leaving after the end of the session is confirmed (the scans are kept, see below).
  page.on('dialog', (d) => void d.accept());
  await page.goto('/production/cycle/after-wash');
  const field = page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ });
  await field.fill(o.bottles[0]!);
  await field.press('Enter');
  await field.fill(o.bottles[1]!);
  await field.press('Enter');
  release();
  await expect(page).toHaveURL(/\/session-expired\?next=/);
  // Only the first scan was attempted; nothing was written.
  expect(posts).toHaveLength(1);
  expect(await reuseState(o.bottles)).toEqual([
    ['RETURNED', 0],
    ['RETURNED', 0],
  ]);

  // Another user in this tab: nothing of the administrator's series.
  await page.goto(`/api/auth/login?next=/production/cycle/after-wash&login_hint=${washerEmail}`);
  await expect(page).toHaveURL(/\/production\/cycle\/after-wash$/);
  await expect(page.getByRole('heading', { name: 'Po mytí', exact: true })).toBeVisible();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  // The same administrator signs in again and, as an account with several sites, chooses the
  // site in the UI — first the other one: nothing of the series there.
  await page.goto(
    '/api/auth/login?next=/production/cycle/after-wash&login_hint=e2e-admin@ayvo.test',
  );
  await expect(page).toHaveURL(/\/select-site\?next=/);
  await page
    .getByTestId('site-choices')
    .locator('li')
    .filter({ hasText: 'E2E-DE' })
    .getByRole('button', { name: 'Pracovat zde' })
    .click();
  await expect(page).toHaveURL(/\/production\/cycle\/after-wash$/);
  await expect(page.getByRole('heading', { name: 'Po mytí', exact: true })).toBeVisible();
  await expect(page.getByTestId('after-wash-scans-unresolved')).toHaveCount(0);
  // Back at the site of the series through the site switcher: both scans restored, stopped.
  // The switcher works only once hydrated (disabled before): a choice before that changed only the
  // native control — no request, the old site still active. The switch is proven by its POST and
  // the session's active site, then the reloaded page (a DOM value or a load event alone is not).
  const switcher = page.getByTestId('site-switcher');
  await expect(switcher).toBeEnabled();
  const switched = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/auth/active-site'),
  );
  const reloaded = page.waitForEvent('framenavigated', (f) => f === page.mainFrame());
  await switcher.selectOption(INITIAL_SITE_ID);
  const switchAnswer = await switched;
  expect(switchAnswer.status()).toBe(200);
  await reloaded;
  await page.waitForLoadState('load');
  const me = (await (await page.request.get('/api/auth/me')).json()) as { activeSiteId: string };
  expect(me.activeSiteId).toBe(INITIAL_SITE_ID);
  await expect(switcher).toBeEnabled();
  await expect(switcher).toHaveValue(INITIAL_SITE_ID);
  const unresolved = page.getByTestId('after-wash-scans-unresolved');
  await expect(unresolved).toContainText('Výsledek posledního skenu není jistý');
  await expect(page.getByTestId('after-wash-scans-waiting')).toHaveText('Čeká na odeslání: 1');
  await page.screenshot({ path: `${SHOTS}/after-wash-session-restored-390.png`, fullPage: true });
  await unresolved.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unresolved).toHaveCount(0);
  // The first scan again with ITS request id, then the second; each bottle once.
  expect(posts).toHaveLength(3);
  expect(posts[1]).toBe(posts[0]);
  expect(posts[2]).not.toBe(posts[0]);
  expect(await reuseState(o.bottles)).toEqual([
    ['READY_FOR_REUSE', 1],
    ['READY_FOR_REUSE', 1],
  ]);
});
