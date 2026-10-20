import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  filledCrate,
  labelingSetup,
  labelledCrate,
  lotIdOf,
  receiveStock,
  type LabelingSetup,
} from './labeling-setup';

/**
 * Hotely → Objednávky → Kompletace (doc 028) on the real built app with synthetic data: a hotel
 * with an explicit fulfilment site, a manual order in whole crates (bottles from the crate type's
 * capacity, 2 here), picking on a phone-sized terminal — focused scan field, large counters, a
 * refused unfinished crate, a harmless re-scan, removal — and "Kompletace dokončena" only when
 * exact (the dispatch that follows is workflow-shipment.spec.ts). Crates are labelled and filled through the API. Screenshots go to AYVO_SCREENSHOT_DIR.
 * (Named to run after warehouse.spec: receiving stock here creates suppliers.)
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let kit: LabelingSetup;
const crates: { url: string; code: string }[] = [];
let unfinished = { url: '', code: '' };
let hotelCode = '';
let orderCode = '';

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
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

const scan = async (page: Page, value: string) => {
  await expect(page.getByTestId('scan-input')).toBeFocused();
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
};

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `expedice-${Date.now()}`, 10);
  kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (expedice E2E)',
  });
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  const liquidLot = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '5000'))!,
  );
  await receiveStock(request, kit.pumpCode, '50');
  for (let i = 0; i < 4; i++) {
    const urls = printed.urls.slice(i * 2, i * 2 + 2);
    const crate = await labelledCrate(request, kit, {
      versionId: printed.versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, { liquidLotId: liquidLot, bottleUrls: urls });
    crates.push(crate);
  }
  // Labelled, not filled: refused by picking.
  unfinished = await labelledCrate(request, kit, {
    versionId: printed.versionId,
    bottleLotCode: bottleLot,
    urls: printed.urls.slice(8, 10),
  });
  await context.close();
});

test('Hotely: a new hotel with an explicit fulfilment site', async ({ page }) => {
  await page.goto('/hotels');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotely');
  await page.getByRole('link', { name: 'Nový hotel' }).first().click();
  await expect(page).toHaveURL(/\/hotels\/new$/);
  const form = page.getByTestId('hotel-form');
  await form.getByRole('button', { name: 'Založit hotel' }).click();
  await expect(page.getByTestId('form-errors')).toBeVisible(); // required fields
  await form.getByLabel('Název hotelu').fill('Hotel Bečva (E2E)');
  await form
    .getByLabel('Obsluhující provozovna')
    .selectOption({ label: 'Přerov 1 (CZ-PREROV-01)' });
  await form.getByLabel('Ulice a číslo').fill('Náměstí T. G. Masaryka 1');
  await form.getByLabel('PSČ').fill('750 02');
  await form.getByLabel('Město').fill('Přerov');
  await form.getByLabel('Země').fill('cz');
  await form.getByLabel('Kontaktní osoba').fill('Jana Recepční');
  await form.getByLabel('Telefon').fill('+420 581 000 111');
  await form.getByLabel('E-mail').fill('recepce@becva.test');
  await shot(page, 'dispatch-01-hotel-new');
  await form.getByRole('button', { name: 'Založit hotel' }).click();
  await expect(page).toHaveURL(/\/hotels\/HT-\d{6}$/);
  hotelCode = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotel Bečva (E2E)');
  await expect(page.getByTestId('hotel-address')).toContainText('750 02 Přerov');
  await expect(page.getByTestId('hotel-site')).toContainText('CZ-PREROV-01');
  await expect(page.getByTestId('hotel-orders')).toContainText('zatím nemá žádnou objednávku');
  await shot(page, 'dispatch-02-hotel-detail');
});

test('Objednávky: a manual order in whole crates; bottles from the crate capacity', async ({
  page,
}) => {
  await page.goto(`/hotels/${hotelCode}`);
  await page.getByRole('link', { name: 'Nová objednávka' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/dispatch/orders/new\\?hotel=${hotelCode}$`));
  const form = page.getByTestId('order-form');
  await expect(form.getByLabel('Hotel')).toHaveValue(hotelCode);
  const line = form.getByTestId(`order-line-${kit.productCode}`);
  await expect(line).toContainText('2 lahví v bedně');
  await line.getByRole('textbox').fill('2');
  await expect(line).toContainText('= 4 lahví');
  await shot(page, 'dispatch-03-order-new');
  await form.getByRole('button', { name: 'Založit objednávku' }).click();
  await expect(page).toHaveURL(/\/dispatch\/orders\/ORD-\d{6}$/);
  orderCode = page.url().split('/').pop()!;
  await expect(page.getByTestId('order-status')).toHaveText('Otevřená');
  expect(orderCode).toMatch(/^ORD-\d{6}$/);
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('0 / 2');
  await expect(page.getByTestId(`line-bottles-${kit.productCode}`)).toHaveText('0 / 4');
  await expect(page.getByTestId('order-delivery')).toContainText('Hotel Bečva (E2E)');
  await shot(page, 'dispatch-04-order-detail');

  await page.goto('/dispatch');
  await expect(page.getByTestId('order-view-today')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId(`order-${orderCode}`)).toContainText('Hotel Bečva (E2E)');
  await expect(page.getByTestId(`order-${orderCode}`)).toContainText('0 / 2');
  await shot(page, 'dispatch-05-orders-today');
});

test('Kompletace on a phone: focused scan, refusals, re-scan, removal, exact completion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  await page.getByTestId('start-picking').click();
  await expect(page).toHaveURL(new RegExp(`/dispatch/orders/${orderCode}/pick$`));
  await expect(page.getByTestId('picking-context')).toContainText('Hotel Bečva (E2E)');
  await expect(page.getByTestId('picking-context')).toContainText(orderCode);
  await expect(page.getByTestId('complete-picking')).toBeDisabled();

  // An unfinished crate is refused with a clear message; nothing is loaded.
  await scan(page, unfinished.url);
  await expect(page.getByTestId('pick-message')).toHaveAttribute('data-tone', 'error');
  await expect(page.getByTestId('pick-message')).toContainText('Bedna není hotová');
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('0 / 2');
  await shot(page, 'dispatch-06-picking-refused');

  await scan(page, crates[0]!.url);
  await expect(page.getByTestId('pick-message')).toContainText(`Bedna ${crates[0]!.code} načtena`);
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('1 / 2');
  await expect(page.getByTestId(`line-bottles-${kit.productCode}`)).toHaveText('2 / 4');
  // A repeated scan changes nothing.
  await scan(page, crates[0]!.url);
  await expect(page.getByTestId('pick-message')).toContainText('už v této objednávce je');
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('1 / 2');

  await scan(page, crates[1]!.url);
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('2 / 2');
  // Over the ordered quantity: refused.
  await scan(page, crates[2]!.url);
  await expect(page.getByTestId('pick-message')).toContainText('už všechny objednané bedny');
  await expect(page.getByTestId('complete-picking')).toBeEnabled();
  await noOverflow(page);
  await shot(page, 'dispatch-07-picking-full');

  // Remove a crate before completion, then load another one.
  await page
    .getByTestId(`picked-${crates[1]!.code}`)
    .getByRole('button', { name: 'Odebrat' })
    .click();
  const dialog = page.getByTestId('remove-crate');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Odebrat' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('1 / 2');
  await expect(page.getByTestId('complete-picking')).toBeDisabled();
  await scan(page, crates[2]!.url);
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('2 / 2');

  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('complete-picking').click();
  await expect(page.getByTestId('picking-ready')).toContainText('Kompletace dokončena');
  await expect(page.getByTestId('scan-input')).toHaveCount(0);
  await shot(page, 'dispatch-08-picking-ready');
});

test('the ready order keeps its history; its crates are held by it', async ({ page }) => {
  await page.goto(`/dispatch/orders/${orderCode}`);
  await expect(page.getByTestId('order-status')).toHaveText('Kompletace dokončena');
  await expect(page.getByTestId('start-picking')).toHaveCount(0);
  const history = page.getByTestId('order-history');
  await expect(history).toContainText('Bedna odebrána');
  await expect(history).toContainText('Kompletace dokončena');
  await expect(page.getByTestId('order-crates')).toContainText(crates[0]!.code);
  await expect(page.getByTestId('order-crates')).toContainText(crates[2]!.code);
  await expect(page.getByTestId('order-crates')).not.toContainText(crates[1]!.code);
  await shot(page, 'dispatch-09-order-ready');
  await page.goto(`/production/crates/${crates[0]!.code}`);
  await expect(page.getByText('Načtena do objednávky')).toBeVisible();
  await expect(page.getByText(`objednávka ${orderCode}`)).toBeVisible();

  // Cancelling releases the crates and keeps the history.
  await page.goto(`/dispatch/orders/${orderCode}`);
  await page.getByRole('button', { name: 'Stornovat objednávku' }).click();
  const dialog = page.getByTestId('cancel-order');
  await dialog.getByRole('textbox').fill('hotel odložil dodávku');
  await dialog.getByRole('button', { name: 'Stornovat' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Stornovaná');
  await expect(page.getByTestId('order-history')).toContainText('Objednávka stornována');
  await expect(page.getByTestId('order-crates')).toContainText('Zatím není načtená žádná bedna');
  await shot(page, 'dispatch-10-order-cancelled');
  await page.goto('/dispatch?view=closed');
  await expect(page.getByTestId(`order-${orderCode}`)).toContainText('Stornovaná');
});

/** A new order of n crates of the kit's product for the hotel, through the API. */
async function apiOrder(page: Page, crates: number): Promise<string> {
  const calendar = await json<{ today: string }>(
    await page.request.get('/api/admin/orders/calendar'),
  );
  const order = await json<{ code: string }>(
    await page.request.post('/api/admin/orders', {
      data: {
        requestId: crypto.randomUUID(),
        hotelCode,
        requestedShipDate: calendar.today,
        lines: [{ productCode: kit.productCode, crates }],
      },
    }),
  );
  return order.code;
}

test('rapid scans are never lost: the next QR is taken while the previous one is saved', async ({
  page,
}) => {
  const code = await apiOrder(page, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${code}/pick`);
  const sent: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route(`**/api/admin/orders/${code}/crates`, async (route) => {
    sent.push((route.request().postDataJSON() as { requestId: string }).requestId);
    if (first) {
      first = false;
      await held; // the first answer is slow
    }
    await route.continue();
  });
  const field = page.getByTestId('scan-input');
  await expect(field).toBeFocused();
  // Two QR codes typed back to back, without waiting for focus or any answer in between.
  await page.keyboard.type(crates[0]!.url);
  await page.keyboard.press('Enter');
  await page.keyboard.type(crates[1]!.url);
  await page.keyboard.press('Enter');
  await expect(field).toBeEnabled();
  await expect(page.getByTestId('picking-unresolved')).toBeVisible();
  await expect(page.getByTestId('complete-picking')).toBeDisabled();
  release();
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('2 / 2');
  await expect(page.getByTestId('scan-log').locator('[data-result="added"]')).toHaveCount(2);
  expect(new Set(sent).size).toBe(2); // two attempts, each with its own id
  await expect(page.getByTestId('picking-unresolved')).toHaveCount(0);
  await page.unroute(`**/api/admin/orders/${code}/crates`);
  await page.getByTestId('complete-picking').click();
  await expect(page.getByTestId('picking-ready')).toBeVisible();
});

test('a lost answer stops picking: no leaving or site switch; reload and retry send the same attempt', async ({
  page,
}) => {
  const code = await apiOrder(page, 2);
  await page.goto(`/dispatch/orders/${code}/pick`);
  const ids: string[] = [];
  let mode: 'lose-before' | 'lose-after' | 'pass' = 'lose-before';
  await page.route(`**/api/admin/orders/${code}/crates`, async (route) => {
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    if (mode === 'lose-before') return route.abort('failed'); // never reached the server
    if (mode === 'lose-after') {
      await route.fetch(); // committed on the server, the answer is lost
      return route.abort('failed');
    }
    return route.continue();
  });
  const siteCalls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/active-site')) siteCalls.push(r.method());
  });

  await scan(page, crates[2]!.url);
  const unresolved = page.getByTestId('picking-unresolved');
  await expect(unresolved).toContainText('Výsledek skenu bedny není jistý');
  await expect(page.getByTestId('complete-picking')).toBeDisabled();
  await shot(page, 'dispatch-11-picking-uncertain');

  // Leaving inside the app is held back.
  await page.getByRole('link', { name: 'Zpět na objednávku' }).click();
  await expect(page.getByRole('dialog')).toContainText('Skeny beden nejsou vyřešené');
  await page.getByRole('button', { name: 'Zpět k vyřešení skenu' }).click();
  await expect(page).toHaveURL(new RegExp(`/dispatch/orders/${code}/pick$`));
  // Switching the site asks first — nothing is sent to the server.
  const switcher = page.getByTestId('site-switcher');
  const other = (await switcher.locator('option', { hasText: 'E2E-DE' }).textContent())!;
  await switcher.selectOption({ label: other });
  await expect(page.getByRole('dialog')).toContainText('Skeny beden nejsou vyřešené');
  await page.getByRole('button', { name: 'Zpět k vyřešení skenu' }).click();
  expect(siteCalls).toEqual([]);

  // A reload keeps the unresolved attempt (this tab), still stopped.
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByTestId('picking-unresolved')).toContainText(
    'Výsledek skenu bedny není jistý',
  );
  mode = 'pass';
  await page.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('1 / 2');
  expect(ids.at(-1)).toBe(ids[0]); // the SAME attempt after the reload

  // Lost after the commit: the retry replays it, nothing is loaded twice.
  mode = 'lose-after';
  const before = ids.length;
  await scan(page, crates[3]!.url);
  await expect(page.getByTestId('picking-unresolved')).toBeVisible();
  mode = 'pass';
  await page.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(page.getByTestId(`line-crates-${kit.productCode}`)).toHaveText('2 / 2');
  expect(ids.slice(before)).toHaveLength(2);
  expect(ids[before + 1]).toBe(ids[before]);
  const detail = await json<{ crates: { crate: string }[] }>(
    await page.request.get(`/api/admin/orders/${code}`),
  );
  expect(detail.crates.map((c) => c.crate).sort()).toEqual(
    [crates[2]!.code, crates[3]!.code].sort(),
  );
  await page.unroute(`**/api/admin/orders/${code}/crates`);
  await page.getByTestId('complete-picking').click();
  await expect(page.getByTestId('picking-ready')).toBeVisible();
});

for (const timezoneId of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
  test(`the ship day follows the site's time zone, not the device's (${timezoneId})`, async ({
    browser,
  }) => {
    // UTC+14 and UTC−11: at any moment at least one of them is on another calendar day than
    // Přerov, so a form using the device's day would fail here.
    const context = await browser.newContext({
      storageState: 'e2e/.auth/admin.json',
      timezoneId,
    });
    const page = await context.newPage();
    const calendar = await json<{ today: string; timeZone: string }>(
      await page.request.get('/api/admin/orders/calendar'),
    );
    expect(calendar.timeZone).toBe('Europe/Prague');
    await page.goto(`/dispatch/orders/new?hotel=${hotelCode}`);
    const date = page.getByTestId('order-form').getByLabel('Požadovaný den odeslání');
    await expect(date).toHaveValue(calendar.today);
    await expect(date).toHaveAttribute('min', calendar.today);
    await page.getByTestId(`order-line-${kit.productCode}`).getByRole('textbox').fill('1');
    await page
      .getByTestId('order-form')
      .getByRole('button', { name: 'Založit objednávku' })
      .click();
    await expect(page).toHaveURL(/\/dispatch\/orders\/ORD-\d{6}$/); // accepted by the server
    const code = page.url().split('/').pop()!;
    await json(
      await page.request.post(`/api/admin/orders/${code}/cancel`, {
        data: { requestId: crypto.randomUUID(), reason: 'konec testu' },
      }),
    );
    await context.close();
  });
}
