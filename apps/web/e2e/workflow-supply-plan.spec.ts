import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, noOverflow, printedBottles } from './dispatch-setup';
import { labelingSetup } from './labeling-setup';

/**
 * Hotel → supply plan → automatic orders (doc 032) on the real built app with synthetic data:
 * the hotel's sections and receiving details, a plan with merged rules and a blocked product, the
 * real 30-day preview, saving with a reason, switching on with a confirmation, orders created by
 * the REAL background round (SUPPLY_PLAN_SECONDS on the e2e server), the origin in Expedice,
 * "Odeslat dne …", a ship day change kept on its occurrence, the overlap warning of a manual
 * order, honest empty deliveries, pausing. Nothing here touches a carrier.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let hotel = '';
let product = { code: '', name: '' };
let noRecipe = '';
let today = '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}
async function threeWidths(page: Page, name: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, `${name}-desktop`);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    await shot(page, `${name}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
const day = (iso: string) => Number(iso.slice(8, 10));
/** A local day `n` days after today (the site's calendar — from the API, never the device). */
const plus = (n: number) => {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `plan-mydlo-${Date.now()}`, 2);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 6,
    productName: 'Tekuté mýdlo (plán E2E)',
  });
  product = { code: kit.productCode, name: 'Tekuté mýdlo (plán E2E)' };
  noRecipe = (
    await json<{ code: string }>(
      await request.post('/api/admin/catalog/products', {
        data: {
          requestId: crypto.randomUUID(),
          code: `NR-${Date.now().toString(36).slice(-5).toUpperCase()}`,
          name: 'Sprchový gel bez receptury (E2E)',
          categoryCode: 'HAND_SOAP',
          nominalQuantity: '330',
          nominalUnitCode: 'ml',
          reason: 'produkt bez receptury pro test',
        },
      }),
    )
  ).code;
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  hotel = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Plán (E2E)',
          addressLine1: 'Komenského 12',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 999',
          contactEmail: 'recepce@plan.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  today = (await json<{ today: string }>(await request.get('/api/admin/orders/calendar'))).today;
  await context.close();
});

test('the hotel in clear sections; receiving details are optional and saved with a reason', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/hotels/${hotel}`);
  await expect(page.getByTestId('hotel-sections').getByRole('link')).toHaveText([
    'Údaje',
    'Smlouva a fakturace',
    'Plán zásobování',
    'Objednávky',
    'Dodávky',
  ]);
  await expect(page.getByTestId('hotel-practical')).toContainText('Nevyplněno');
  await expect(page.getByTestId('hotel-plan')).toContainText('Hotel zatím nemá plán zásobování.');
  await expect(page.getByTestId('hotel-deliveries')).toContainText('Zatím žádné doručené');
  await page.getByTestId('edit-practical').click();
  const dialog = page.getByTestId('practical-dialog');
  await dialog
    .getByLabel('Pokyny k doručení')
    .fill('Příjem zboží 7–15 h, zadní vchod u parkoviště');
  await dialog.getByLabel('Kontakt pro příjem zboží – Jméno').fill('Jana Skladová');
  await dialog.getByLabel('Telefon (nepovinné)').fill('+420 600 000 111');
  await dialog.getByRole('textbox', { name: /Důvod/ }).fill('doplněno z telefonátu');
  await dialog.getByRole('button', { name: 'Uložit' }).click();
  await expect(page.getByTestId('hotel-practical')).toContainText('zadní vchod');
  await expect(page.getByTestId('hotel-practical')).toContainText(
    'Jana Skladová, +420 600 000 111',
  );
  await threeWidths(page, 'plan-01-hotel-empty');
  await page.getByTestId('create-plan').click();
  await page.waitForURL(`**/hotels/${hotel}/plan`);
});

test('the plan: merged rules, a blocked product, the real preview; saved switched off, then switched on', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/hotels/${hotel}/plan`);
  const editor = page.getByTestId('plan-editor');
  // Rule 1: 2 crates today and in 2 days; rule 2: +1 crate today (one line of 3 crates).
  await editor.getByTestId('plan-rule-1-product').selectOption(product.code);
  await editor.getByTestId('plan-rule-1-crates').fill('2');
  await editor.getByTestId(`plan-rule-1-day-${day(today)}`).click();
  await editor.getByTestId(`plan-rule-1-day-${day(plus(2))}`).click();
  await editor.getByTestId('plan-add-rule').click();
  await editor.getByTestId('plan-rule-2-product').selectOption(product.code);
  await editor.getByTestId(`plan-rule-2-day-${day(today)}`).click();
  // A product without a recipe is not offered (nothing can be ordered of it).
  await expect(
    editor.getByTestId('plan-rule-2-product').locator(`option[value="${noRecipe}"]`),
  ).toHaveCount(0);
  await expect(editor).toContainText('dodávka se ten měsíc neplánuje');
  await editor.getByTestId('plan-preview').click();
  const preview = page.getByTestId('plan-preview-result');
  await expect(preview.getByTestId('plan-what')).toContainText('Co se bude vytvářet');
  const first = preview.getByTestId(`plan-day-${today}`);
  await expect(first).toContainText(`${product.name}: 3 ×`);
  await expect(first).toContainText('18 lahví'); // 3 crates × capacity 6 — never 40
  // The preview wrote nothing: still no plan.
  expect(
    (
      await json<{ plan: unknown }>(
        await page.request.get(`/api/admin/orders/hotel/${hotel}/supply-plan`),
      )
    ).plan,
  ).toBeNull();
  await threeWidths(page, 'plan-02-preview');
  await editor.getByTestId('plan-save').click();
  const dialog = page.getByTestId('plan-dialog');
  await dialog.getByRole('textbox', { name: /Důvod/ }).fill('dohodnuto s hotelem');
  await dialog.getByRole('button', { name: 'Uložit plán' }).click();
  await expect(page.getByTestId('plan-state').getByTestId('plan-status')).toHaveText('Vypnutý');
  // A rule whose product cannot be ordered (no recipe — e.g. its recipe ended later): saved
  // through the API as a new version; the editor keeps it and the preview shows the blocker.
  await json(
    await page.request.post(`/api/admin/orders/hotel/${hotel}/supply-plan`, {
      data: {
        requestId: crypto.randomUUID(),
        validFrom: today,
        validTo: null,
        rules: [
          { productCode: product.code, crates: 2, days: [day(today), day(plus(2))] },
          { productCode: product.code, crates: 1, days: [day(today)] },
          { productCode: noRecipe, crates: 1, days: [day(plus(4))] },
        ],
        reason: 'doplněn gel podle smlouvy',
      },
    }),
  );
  await page.reload();
  await expect(page.getByTestId('plan-rule-3-product')).toHaveValue(noRecipe);
  const state = page.getByTestId('plan-state');
  const crates = page.getByTestId('plan-rule-1-crates');
  const planStatus = async () =>
    (
      await json<{ plan: { status: string; version: number } }>(
        await page.request.get(`/api/admin/orders/hotel/${hotel}/supply-plan`),
      )
    ).plan;
  // PLAN40-R1: a different quantity in the form, not saved — switching on is refused (only the
  // saved plan is ever switched on; nothing saved or discarded behind the user's back).
  await crates.fill('1');
  await expect(state.getByTestId('plan-unsaved')).toBeVisible();
  await page.getByTestId('plan-activate').click();
  await expect(state.getByTestId('plan-activate-error')).toContainText('neuložené změny');
  await expect(dialog).toBeHidden();
  await expect(crates).toHaveValue('1'); // the edit is kept
  // An invalid form: no dialog either.
  await crates.fill('');
  await page.getByTestId('plan-activate').click();
  await expect(state.getByTestId('plan-activate-error')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(await planStatus()).toMatchObject({ status: 'INACTIVE', version: 2 });
  // A preview of the form becomes visibly stale after an edit.
  await crates.fill('2');
  await expect(state.getByTestId('plan-unsaved')).toHaveCount(0);
  await page.getByTestId('plan-preview').click();
  const result = page.getByTestId('plan-preview-result');
  await expect(result.getByTestId('plan-what')).toBeVisible();
  await expect(result.getByTestId('plan-preview-stale')).toHaveCount(0);
  await crates.fill('7');
  await expect(result.getByTestId('plan-preview-stale')).toBeVisible();
  await crates.fill('2');
  await expect(result.getByTestId('plan-preview-stale')).toHaveCount(0);
  // The saved plan's preview fails to load: no dialog, a clear message, nothing switched on.
  await page.route(`**/api/admin/orders/hotel/${hotel}/supply-plan/preview`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, body: '{"message":"unavailable"}' })
      : route.continue(),
  );
  await page.getByTestId('plan-activate').click();
  await expect(state.getByTestId('plan-activate-error')).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.unroute(`**/api/admin/orders/hotel/${hotel}/supply-plan/preview`);
  expect(await planStatus()).toMatchObject({ status: 'INACTIVE', version: 2 });
  // Switching on: the saved plan's preview, its version, an explicit confirmation.
  await page.getByTestId('plan-activate').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('plan-confirm-version')).toContainText('uložená verze 2');
  await expect(dialog.getByTestId('plan-confirm-what')).toContainText(product.name);
  await expect(dialog.getByRole('button', { name: 'Ano, zapnout plán' })).toBeDisabled();
  await expect(
    page.getByTestId('plan-preview-result').getByTestId(`plan-day-${plus(4)}`),
  ).toContainText('nemá aktivní recepturu');
  await dialog.getByTestId('plan-activate-check').check();
  await dialog.getByRole('button', { name: 'Ano, zapnout plán' }).click();
  await expect(page.getByTestId('plan-state').getByTestId('plan-status')).toHaveText('Zapnutý');
  // The real background round creates the orders (today and in 2 days; the blocked day not).
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId('plan-orders').locator('li').count();
      },
      { timeout: 30_000 },
    )
    .toBe(2);
  await threeWidths(page, 'plan-03-switched-on-orders');
});

test('Expedice: the same workflow; origin shown; a future one "Odeslat dne …"; a moved day keeps its occurrence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/dispatch');
  const todays = page.getByTestId('orders').locator('li', { hasText: 'Hotel Plán (E2E)' });
  await expect(todays.getByTestId('order-origin')).toHaveText('Z plánu zásobování');
  await page.goto('/dispatch?view=future');
  const future = page.getByTestId('orders').locator('li', { hasText: 'Hotel Plán (E2E)' });
  await expect(future.locator('[data-testid$="-send-on"]')).toHaveText(/^Odeslat dne /);
  const code = (await future.locator('a').first().textContent())!.trim();
  await shot(page, 'plan-04-dispatch-future-desktop');
  await page.goto(`/dispatch/orders/${code}`);
  await expect(page.getByTestId('order-from-plan')).toContainText('Z plánu zásobování hotelu');
  // Sent one day earlier: explicit, with a reason; the plan is not changed.
  await page.getByTestId('reschedule-order').click();
  const dialog = page.getByTestId('reschedule-dialog');
  await dialog.getByTestId('reschedule-date').fill(plus(1));
  await dialog.getByRole('textbox', { name: /Důvod/ }).fill('hotel potřebuje dřív');
  await dialog.getByRole('button', { name: 'Změnit den odeslání' }).click();
  await expect(page.getByTestId('order-history')).toContainText('Změněn den odeslání');
  await expect(page.getByTestId('order-history')).toContainText('→');
  await expect(page.getByTestId('order-history')).toContainText(
    'Objednávka založena · Z plánu zásobování',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'plan-05-order-from-plan-390');
  // A few rounds later: still two orders — no replacement for the original day.
  await page.waitForTimeout(5_000);
  await page.goto(`/hotels/${hotel}/plan`);
  await expect(page.getByTestId('plan-orders').locator('li')).toHaveCount(2);
  await expect(page.getByTestId(`plan-order-${code}`)).toContainText('termín plánu');
});

test("a manual extra order stays possible; the hotel's nearby orders are shown, nothing merged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/new?hotel=${hotel}`);
  await expect(page.getByTestId('order-nearby')).toContainText('Z plánu zásobování');
  await noOverflow(page);
  await shot(page, 'plan-06-manual-order-overlap-390');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page);
  await shot(page, 'plan-06-manual-order-overlap-320');
});

test('the hotel: plan summary, orders with origin, honest deliveries; pausing keeps the orders', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/hotels/${hotel}`);
  const plan = page.getByTestId('hotel-plan');
  await expect(plan.getByTestId('plan-status')).toHaveText('Zapnutý');
  await expect(plan).toContainText('Poslední úspěšné vyhodnocení');
  await expect(plan.getByTestId('plan-blocked')).toContainText('nemá aktivní recepturu');
  await expect(page.getByTestId('hotel-orders').getByTestId('order-origin').first()).toHaveText(
    'Z plánu zásobování',
  );
  // Nothing delivered yet: the open quantities only; the chart says it has nothing.
  const deliveries = page.getByTestId('hotel-deliveries');
  await expect(deliveries.getByTestId('deliveries-chart-empty')).toBeVisible();
  await expect(deliveries.getByTestId('deliveries-table')).toContainText(product.name);
  await threeWidths(page, 'plan-07-hotel-with-plan');
  await page.goto(`/hotels/${hotel}/plan`);
  await page.getByTestId('plan-pause').click();
  const dialog = page.getByTestId('plan-dialog');
  await dialog.getByRole('textbox', { name: /Důvod/ }).fill('hotel v rekonstrukci');
  await dialog.getByRole('button', { name: 'Pozastavit' }).click();
  await expect(page.getByTestId('plan-state').getByTestId('plan-status')).toHaveText('Pozastavený');
  await expect(page.getByTestId('plan-orders').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('plan-orders-warning')).toContainText('nepřepíše ani nezruší');
});
