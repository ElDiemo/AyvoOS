import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * The Svoz walkthrough (doc 029 §11) through the real UI with the REAL PPL adapter against the
 * SIMULATED PPL API (test/support/fake-ppl.ts) — never a real PPL host. Runs only in the isolated
 * walkthrough set (E2E_CARRIER=ppl, own ports and database; see docs/067), skipped otherwise:
 *
 * labels create no pickup → a part of the ready orders selected → ordered, history and numbers →
 * cancelled → held while PPL has not confirmed → PPL confirms (simulation) → the same labels
 * planned again → PPL collects 1 of 2 parcels → a pickup of only the remaining one; separately a
 * delivery without a pickup scan, and an outage with the lost answer. Desktop and phone
 * screenshots (AYVO_SCREENSHOT_DIR).
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });
test.skip(process.env.E2E_CARRIER !== 'ppl', 'the isolated PPL walkthrough only (E2E_CARRIER=ppl)');

const CONTROL = `http://127.0.0.1:${process.env.E2E_FAKE_PPL_PORT ?? 4195}/__fake-ppl/control`;
const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
/** D: picked, not yet labelled — the dispatch outcomes (refused, tracking outage) on the order. */
let orderD = '';
const orders: Record<'a' | 'b' | 'c', { code: string; numbers: string[] }> = {
  a: { code: '', numbers: [] },
  b: { code: '', numbers: [] },
  c: { code: '', numbers: [] },
};
const days = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

async function control(request: APIRequestContext, body: object) {
  expect((await request.post(CONTROL, { data: body })).ok()).toBe(true);
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, width, height] of [
    ['desktop', 1280, 900],
    ['390', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await noOverflow(page);
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.min(full, 4000) });
    await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}
/** Leaves only these orders selected on the board. */
async function select(page: Page, keep: string[]) {
  for (const box of await page.locator('[data-testid^="pickup-select-"]').all()) {
    const code = (await box.getAttribute('data-testid'))!.replace('pickup-select-', '');
    if (!(await box.isEnabled())) continue;
    // Each click is followed by its state (the board may re-render after a refresh).
    if (keep.includes(code)) {
      await box.check();
      await expect(box).toBeChecked();
    } else {
      await box.uncheck();
      await expect(box).not.toBeChecked();
    }
  }
}
async function orderPickup(page: Page, date: string, expectParcels: number) {
  // Each pickup once on the page: the waiting one in its card above, the others in the history.
  const items = page.locator('[data-testid^="pickup-SV-"]');
  const before = await items.count();
  await page.getByTestId('pickup-date').fill(date);
  await page.getByTestId('pickup-order').click();
  const dialog = page.getByTestId('pickup-confirm');
  await expect(dialog).toContainText(`vyzvedl ${expectParcels} balíků`);
  await dialog.getByTestId('pickup-confirm-check').check();
  await dialog.getByRole('button', { name: 'Objednat svoz' }).click();
  await expect(items).toHaveCount(before + 1);
  const item = items.first();
  const code = (await item.getAttribute('data-testid'))!.replace('pickup-', '');
  // Sent (never left as written): its technical state is in Podrobnosti.
  await expect(item.getByTestId(`pickup-system-state-${code}`)).not.toHaveText('PREPARED');
  return { item, code };
}
async function refreshTracking(page: Page, order: string) {
  await page.goto(`/dispatch/orders/${order}`);
  // Wait for the refresh itself (the card may already show an earlier check).
  const done = page.waitForResponse(
    (r) => r.url().endsWith(`/orders/${order}/shipment/tracking/refresh`) && r.ok(),
  );
  await page.getByTestId('tracking-card').getByTestId('tracking-refresh').click();
  await done;
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  await control(request, { reset: true });
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  // The site's PPL settings against the simulation (verified: token + product list only).
  const settings = `/api/admin/sites/${siteId}/carriers/ppl`;
  const sender = {
    name: 'AYVO Prerov (simulace)',
    street: 'Prumyslova 1',
    city: 'Prerov',
    postalCode: '750 02',
    country: 'CZ',
    contact: 'Expedice',
    phone: '+420 581 000 333',
    email: 'expedice@ayvo.test',
  };
  const save = (productCode: string | null) =>
    request.put(settings, {
      data: {
        requestId: crypto.randomUUID(),
        enabled: true,
        connection: 'PPL_TEST',
        sender,
        productCode,
        label: { layout: 'SINGLE' },
      },
    });
  await json(await save(null));
  const verified = await json<{ ok: boolean }>(
    await request.post(`${settings}/verify`, { data: { requestId: crypto.randomUUID() } }),
  );
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  await json(await save('SIM-A'));

  const printed = await printedBottles(request, `svoz-ppl-${Date.now()}`, 12);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (svoz PPL simulace)',
  });
  await json(
    await request.post(`/api/admin/catalog/products/${kit.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  await receiveStock(request, kit.pumpCode, '20');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '5000'))!,
  );
  const crates: { url: string; code: string }[] = [];
  for (let i = 0; i < 6; i++) {
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
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Svoz PPL (simulace)',
          addressLine1: 'Wilsonova 7',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 555',
          contactEmail: 'recepce@svoz-ppl.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  const plan: ['a' | 'b' | 'c', number][] = [
    ['a', 2],
    ['b', 1],
    ['c', 2],
  ];
  let next = 0;
  for (const [key, n] of plan) {
    const code = (
      await json<{ code: string }>(
        await request.post('/api/admin/orders', {
          data: {
            requestId: crypto.randomUUID(),
            hotelCode,
            requestedShipDate: days(0),
            lines: [{ productCode: kit.productCode, crates: n }],
          },
        }),
      )
    ).code;
    for (let i = 0; i < n; i++) {
      await json(
        await request.post(`/api/admin/orders/${code}/crates`, {
          data: { requestId: crypto.randomUUID(), scannedValue: crates[next++]!.url },
        }),
      );
    }
    await json(
      await request.post(`/api/admin/orders/${code}/complete-and-label`, {
        data: { requestId: crypto.randomUUID(), printerId: null },
      }),
    );
    const s = await json<{ shipment: { parcels: { carrierParcelNumber: string }[] } }>(
      await request.post(`/api/admin/orders/${code}/shipment/ready`, {
        data: { requestId: crypto.randomUUID(), labelsApplied: true },
      }),
    );
    orders[key] = { code, numbers: s.shipment.parcels.map((p) => p.carrierParcelNumber) };
  }
  orderD = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: days(0),
          lines: [{ productCode: kit.productCode, crates: 1 }],
        },
      }),
    )
  ).code;
  await json(
    await request.post(`/api/admin/orders/${orderD}/crates`, {
      data: { requestId: crypto.randomUUID(), scannedValue: crates[next++]!.url },
    }),
  );
  await context.close();
});

test('svoz PPL: labels without a pickup → part ordered → cancelled → held → confirmed → planned again → partial pickup', async ({
  page,
  request,
}) => {
  const { a, b, c } = orders;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/dispatch/pickups');
  // Labels exist, no pickup was created for them.
  await expect(page.getByTestId('pickup-environment').first()).toContainText('Testovací prostředí');
  for (const o of [a, b, c]) {
    await expect(page.getByTestId(`pickup-select-${o.code}`)).toBeEnabled();
    await expect(
      page.locator('[data-testid^="pickup-SV-"]').filter({ hasText: o.code }),
    ).toHaveCount(0);
  }
  // No parcel selected: nothing can be ordered.
  await select(page, []);
  await expect(page.getByTestId('pickup-total')).toHaveText('Vybráno 0 obj., 0 balíků');
  await expect(page.getByTestId('pickup-order')).toBeDisabled();
  await shot(page, 'svoz-01-nothing-selected');

  // A part of the ready orders: A (2 parcels) and B (1), C stays.
  await select(page, [a.code, b.code]);
  await expect(page.getByTestId('pickup-total')).toHaveText('Vybráno 2 obj., 3 balíků');
  const first = await orderPickup(page, days(1), 3);
  await expect(page.getByTestId(`pickup-status-${first.code}`)).toHaveText('Svoz potvrzen');
  for (const n of [...a.numbers, ...b.numbers]) await expect(first.item).toContainText(n);
  await expect(first.item).not.toContainText(c.numbers[0]!);
  await expect(first.item).toContainText('Stav balíku dnes');
  await shot(page, 'svoz-02-ordered');

  // Cancel — PPL accepts it but shows it cancelled only later.
  await control(request, { mode: { cancelOrderShownAfter: 1000 } });
  await page.getByTestId(`pickup-cancel-button-${first.code}`).click();
  const dialog = page.getByTestId(`pickup-cancel-dialog-${first.code}`);
  await dialog.getByRole('textbox').fill('Zákazník posunul termín');
  await page.getByTestId(`pickup-cancel-check-${first.code}`).check();
  await dialog.getByRole('button', { name: 'Požádat o zrušení' }).click();
  await expect(page.getByTestId(`pickup-status-${first.code}`)).toHaveText(
    'Čekáme na potvrzení storna. Balíky zatím nelze přeplánovat.',
  );
  // Held while not confirmed: not selectable, and the API refuses another day too.
  await expect(page.getByTestId(`pickup-select-${a.code}`)).toBeDisabled();
  const refused = await page.request.post('/api/admin/dispatch/pickups', {
    data: {
      requestId: crypto.randomUUID(),
      date: days(3),
      window: null,
      orders: [a.code],
      confirmed: true,
    },
  });
  expect((await refused.json()).code).toBe('ORDER_IN_PICKUP');
  await shot(page, 'svoz-03-cancel-pending');

  // PPL confirms (the simulation now shows Canceled). Nobody clicks "Zjistit stav" and the page is
  // not reloaded: the server's own lookup confirms it, and the open board, read again from our
  // server while the server still looks something up, shows it and frees the order.
  test.setTimeout(240_000);
  const manualLookups: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/dispatch\/pickups\/[^/]+\/lookup$/.test(r.url())) {
      manualLookups.push(r.url());
    }
  });
  let loads = 0;
  page.on('load', () => (loads += 1));
  await control(request, { showCancelled: true });
  await expect(page.getByTestId(`pickup-status-${first.code}`)).toHaveText('Svoz zrušen', {
    timeout: 90_000,
  });
  await expect(page.getByTestId(`pickup-select-${a.code}`)).toBeEnabled();
  expect(manualLookups).toEqual([]);
  expect(loads).toBe(0);
  // Nothing is settled by the server any more: the board stops reading itself again.
  const boardReads: string[] = [];
  const onRequest = (r: Request) => {
    if (r.url().includes('/dispatch/pickups') && r.headers()['rsc']) boardReads.push(r.url());
  };
  page.on('request', onRequest);
  await page.waitForTimeout(35_000); // more than two refresh periods
  page.off('request', onRequest);
  expect(boardReads).toEqual([]);
  await shot(page, 'svoz-04-cancel-confirmed');

  // The same labels planned again (A and B, the day after tomorrow).
  await control(request, { mode: { cancelOrderShownAfter: 0 } });
  await select(page, [a.code, b.code]);
  const second = await orderPickup(page, days(2), 3);
  for (const n of [...a.numbers, ...b.numbers]) await expect(second.item).toContainText(n);
  // The cancelled pickup stays in the history with its parcels.
  await expect(page.getByTestId(`pickup-${first.code}`)).toContainText(a.numbers[0]!);

  // PPL collects 1 of A's 2 parcels (tracking), then the pickup is cancelled (confirmed at once):
  // a new pickup announces only A's remaining parcel.
  await control(request, {
    mode: {
      events: {
        [a.numbers[0]!]: [
          {
            statusId: 150,
            code: 'PickedUp',
            phase: 'InTransport',
            group: 'PickedUp',
            eventDate: new Date(Date.now() - 60_000).toISOString(),
            name: 'Zásilku jsme převzali od odesílatele.',
          },
        ],
      },
    },
  });
  await refreshTracking(page, a.code);
  await page.goto('/dispatch/pickups');
  await page.getByTestId(`pickup-cancel-button-${second.code}`).click();
  const d2 = page.getByTestId(`pickup-cancel-dialog-${second.code}`);
  await d2.getByRole('textbox').fill('Řidič vzal jen část zásilek');
  await page.getByTestId(`pickup-cancel-check-${second.code}`).check();
  await d2.getByRole('button', { name: 'Požádat o zrušení' }).click();
  await expect(page.getByTestId(`pickup-status-${second.code}`)).toHaveText('Svoz zrušen');
  await expect(page.getByTestId('pickup-candidates')).toContainText('převzato 1');
  await select(page, [a.code]);
  await expect(page.getByTestId('pickup-total')).toHaveText('Vybráno 1 obj., 1 balíků');
  const third = await orderPickup(page, days(1), 1);
  await expect(third.item).toContainText(a.numbers[1]!);
  await expect(third.item).not.toContainText(a.numbers[0]!);
  // Today's state of the collected parcel, also on the cancelled pickups — labelled as such.
  await expect(page.getByTestId(`pickup-${second.code}`)).toContainText('u dopravce');
  await shot(page, 'svoz-05-partial-pickup');
});

test('svoz PPL: a delivery without a pickup scan; an outage with the lost answer', async ({
  page,
  request,
}) => {
  const { c } = orders;
  // PPL reports C's first parcel delivered — no pickup scan (CARRIER_IMPLIED).
  await control(request, {
    mode: {
      events: {
        [c.numbers[0]!]: [
          {
            statusId: 450,
            code: 'Delivered',
            phase: 'Delivered',
            group: 'Delivered',
            eventDate: new Date(Date.now() - 60_000).toISOString(),
            name: 'Zásilku jsme doručili příjemci.',
          },
        ],
      },
    },
  });
  await refreshTracking(page, c.code);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dispatch/pickups');
  await expect(page.locator('li', { hasText: c.code })).toContainText('převzato 1');
  await select(page, [c.code]);
  await expect(page.getByTestId('pickup-total')).toHaveText('Vybráno 1 obj., 1 balíků');
  await shot(page, 'svoz-06-delivered-without-scan');

  // PPL down while ordering: the answer is lost — uncertain, never sent again.
  await control(request, { mode: { down: true } });
  const lost = await orderPickup(page, days(1), 1);
  await expect(page.getByTestId(`pickup-status-${lost.code}`)).toHaveText('Čekáme na PPL');
  await expect(page.getByTestId(`pickup-hint-${lost.code}`)).toContainText('zatím nepotvrdilo');
  await expect(lost.item).not.toContainText('ztratil');
  await expect(page.getByTestId('pickup-order')).toBeDisabled(); // the site waits for it
  await shot(page, 'svoz-07-lost-answer');
  // After the outage: looked up by its own reference — PPL does not have it.
  await control(request, { mode: { down: false } });
  await page.getByTestId(`pickup-lookup-${lost.code}`).click();
  await expect(page.getByTestId(`pickup-status-${lost.code}`)).toHaveText('Čekáme na PPL');
  // Closed by a person after checking with PPL (in Podrobnosti); then a new pickup of the parcel.
  await page.getByTestId(`pickup-details-${lost.code}`).locator('summary').click();
  await page.getByTestId(`pickup-resolve-${lost.code}`).click();
  const dialog = page.getByTestId(`pickup-resolve-dialog-${lost.code}`);
  await dialog.getByRole('textbox').fill('PPL potvrdila, že svoz nemá');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Uzavřít' }).click();
  await expect(page.getByTestId(`pickup-status-${lost.code}`)).toContainText('nebyl objednán');
  await select(page, [c.code]);
  const again = await orderPickup(page, days(1), 1);
  await expect(page.getByTestId(`pickup-status-${again.code}`)).toHaveText('Svoz potvrzen');
  await expect(again.item).toContainText(c.numbers[1]!);
  await shot(page, 'svoz-08-after-outage');
});

test('Expedice PPL: refused labels said in Czech, the reason under Podrobnosti; a tracking outage the same', async ({
  page,
  request,
}) => {
  // PPL refuses the shipment (400 validation): nothing was created.
  await control(request, { mode: { reject: true } });
  await json(
    await request.post(`/api/admin/orders/${orderD}/complete`, {
      data: { requestId: crypto.randomUUID() },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderD}`);
  await page.getByTestId('create-labels').click();
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute('data-phase', 'CREATE');
  await expect(page.getByTestId('shipment-refused')).toContainText('odmítl – nic nevzniklo');
  // The carrier's own words only under Podrobnosti, opened with the keyboard.
  const error = page.getByTestId('shipment-request-error');
  await expect(error).toBeHidden();
  await page.getByTestId('shipment-details').locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(error).toBeVisible();
  await expect(error).not.toBeEmpty();
  // The history names the refusal; the carrier's text there is under Podrobnosti too.
  const history = page.getByTestId('order-history');
  await expect(history).toContainText('Dopravce požadavek odmítl');
  await expect(history.getByText(/validation errors/)).toBeHidden();
  await shot(page, 'expedice-01-refused');

  // Fixed at the carrier: one new request makes the labels. PPL's tracking is down from the
  // start, so this shipment is never checked successfully (no lastSuccessAt).
  await control(request, { mode: { reject: false, trackingDown: true } });
  await page.getByTestId('create-labels').click();
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute('data-phase', 'LABELED');
  await expect(page.getByTestId('shipment-refused')).toHaveCount(0);

  // PPL's tracking down: the last known state stays, the reason under Podrobnosti.
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/orders/${orderD}/shipment/tracking/refresh`),
  );
  await page.getByTestId('tracking-card').getByTestId('tracking-refresh').click();
  await answered;
  await page.reload();
  await expect(page.getByTestId('tracking-failed')).toContainText('se nepovedlo');
  await expect(page.getByTestId('tracking-failed')).not.toContainText('503');
  const outage = page.getByTestId('tracking-failed-details');
  await outage.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(outage.locator('dd')).not.toBeEmpty();
  await expect(page.getByTestId('tracking-paused')).toHaveCount(0);
  await shot(page, 'expedice-02-tracking-outage');

  // Still down: every look fails until checking stops (GAVE_UP). Then one true first layer — no
  // "ověří se znovu samo" beside "zastavené" — the action this role can take, the reason below.
  type Tracked = { shipment: { tracking: { stopped: string | null } } };
  for (let i = 0; i < 12; i++) {
    const view = await json<Tracked>(
      await request.post(`/api/admin/orders/${orderD}/shipment/tracking/refresh`, {
        data: { requestId: crypto.randomUUID() },
      }),
    );
    if (view.shipment.tracking.stopped === 'GAVE_UP') break;
  }
  await page.reload();
  const card = page.getByTestId('tracking-card');
  await expect(card.getByTestId('tracking-paused')).toContainText('zastavené');
  await expect(card.getByTestId('tracking-paused')).toContainText('„Obnovit tracking“ ho znovu');
  await expect(card.getByTestId('tracking-failed')).toHaveCount(0);
  await expect(card).not.toContainText('ověří se znovu samo');
  await expect(card.getByTestId('tracking-failed-details').locator('dd')).toBeHidden();
  // Never checked successfully: no promise that it will be checked by itself.
  await expect(card.getByTestId('tracking-checked')).toHaveText('U dopravce zatím neověřeno.');
  await expect(card).not.toContainText('ověří se automaticky');
  await shot(page, 'expedice-03-tracking-stopped');

  // PPL back: "Obnovit tracking" resumes; the stop and the outage are gone.
  await control(request, { mode: { trackingDown: false } });
  await card.getByTestId('tracking-refresh').click();
  await expect(card.getByTestId('tracking-paused')).toHaveCount(0);
  await expect(card.getByTestId('tracking-failed')).toHaveCount(0);
  await expect(card.getByTestId('tracking-checked')).toContainText('Naposledy ověřeno u dopravce');
});
