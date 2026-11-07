import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eRows, e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * Příjem vratek R1 (doc 047 §4.9) on the real built app with synthetic data and the FAKE test
 * carrier: two crates delivered by SIMULATED carrier events (written into the recreated e2e
 * database only, PPL code 450), then the intake through the UI — crate K scanned back, its
 * bottle and a bottle of crate L (still delivered) identified in K, an unreadable piece, a
 * defective pump, the physical count, Vyprázdněno and the close — at 390 px and 1440 px. Then R2
 * "Po mytí" (doc 048 §2) of the good bottles, a repeated scan, a refused defective one, and a
 * revoked design set aside — screenshots in docs/screenshots/returns.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/returns');
let orderCode = '';
let productCode = '';
let versionId = '';
const crates: { url: string; code: string; bottles: string[] }[] = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `returns-mydlo-${Date.now()}`, 8);
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '10'))!;
  await receiveStock(request, kit.pumpCode, '10');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '3000'))!,
  );
  // K and L for the intake; M and N come back later for the scan series of "Po mytí".
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

async function wash(page: Page, url: string) {
  await page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ }).fill(url);
  await page.getByRole('button', { name: 'Po mytí – připravit k plnění' }).click();
}

for (const width of [390, 1440] as const) {
  test(`"Po mytí" at ${width} px: the second scan after washing, the queue`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const [k, l] = crates as [(typeof crates)[number], (typeof crates)[number]];
    await page.goto('/warehouse/after-wash');
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
    const { lineId } = await json<{ lineId: string }>(
      await page.request.post(`/api/admin/returns/receipts/${receipt.code}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
    for (const url of c.bottles) {
      await json(
        await page.request.post(
          `/api/admin/returns/receipts/${receipt.code}/lines/${lineId}/bottles`,
          { data: { requestId: crypto.randomUUID(), scannedValue: url, outcome: 'GOOD' } },
        ),
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

  await page.goto('/warehouse/after-wash');
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
