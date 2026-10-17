import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { labelingSetup, type LabelingSetup } from './labeling-setup';

/**
 * Weights and dimensions (doc 025 §10, W1) on the real built app with synthetic values: unknown
 * until measured (never 0), components per unit and the liquid as a weighed sample, the crate
 * tare in kg, dimensions of the crate and the shipping package, a correction that keeps the old
 * value, the expected full crate = bottles × finished bottle + tare (components only a
 * cross-check), and read-only for a production operator. Named to run after warehouse.spec
 * (the setup receives stock). Screenshots go to AYVO_SCREENSHOT_DIR.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: '390', width: 390, height: 844 },
  { name: '320', width: 320, height: 740 },
];
let kit: LabelingSetup;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
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
async function measure(request: APIRequestContext, path: string, body: object) {
  const res = await request.post(path, {
    data: {
      requestId: crypto.randomUUID(),
      measuredOn: '2026-10-15',
      method: 'Syntetická hodnota pro test',
      correctionOf: null,
      correctionReason: null,
      ...body,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  kit = await labelingSetup(context.request, {
    versionId: '',
    approve: false,
    productName: 'Mýdlo pro vážení (E2E)',
  });
  await context.close();
});

test('unknown until measured: never 0, the expected crate stays unknown', async ({ page }) => {
  await page.goto(`/production/catalog/products/${kit.productCode}`);
  await expect(page.getByTestId('product-weight-current')).toHaveAttribute('data-state', 'unknown');
  await expect(page.getByTestId('expected-crate')).toHaveText('neznámá');
  await expect(page.getByTestId('expected-missing')).toContainText('hotovou lahev');
  await expect(page.getByTestId('expected-missing')).toContainText('táru bedny');
  await expect(page.getByTestId('crate-expectation')).not.toContainText(' 0 g');
});

test('components: per piece and the liquid as a weighed sample, through the forms', async ({
  page,
}) => {
  await page.goto('/production/catalog/components');
  await page.getByTestId(`component-${kit.labelCode}`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/production/catalog/components/${kit.labelCode}$`));
  const form = page.getByTestId('component-weight-form');
  await form.getByLabel('Hmotnost (g)').fill('0,512');
  await form.getByLabel(/Způsob měření/).fill('Laboratorní váha, 10 etiket / 10');
  await form.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('component-weight-current')).toContainText('0,512 g / 1 ks');

  await page.goto(`/production/catalog/components/${kit.liquidCode}`);
  const liquid = page.getByTestId('component-weight-form');
  await liquid.getByLabel('Hmotnost vzorku (g)').fill('103,4');
  await liquid.getByLabel(/Objem vzorku/).fill('100');
  await liquid.getByLabel(/Způsob měření/).fill('Odměrný válec 100 ml, tárovaná nádoba');
  await liquid.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('component-weight-current')).toContainText('103,4 g na 100 ml');
  await expect(page.getByTestId('component-weight')).toContainText('330 ml není 330 g');
  await shot(page, 'w1-01-component-liquid-desktop');
});

test('crate type: tare in kg, dimensions, a package with an extra carton; a correction keeps history', async ({
  page,
}) => {
  await page.goto('/production/catalog/crate-types');
  await page.getByTestId(`crate-${kit.crateTypeCode}`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/production/catalog/crate-types/${kit.crateTypeCode}$`));
  const tare = page.getByTestId('tare-form');
  await tare.getByLabel('Hmotnost (kg)').fill('1,85');
  await tare.getByLabel(/Konfigurace bedny/).fill('Bedna s přepážkami 5 × 8');
  await tare.getByLabel(/Způsob měření/).fill('Plošinová váha 1 g');
  await tare.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('crate-tare-current')).toContainText('1,85 kg');

  const crate = page.getByTestId('crate-dims-form');
  await crate.getByLabel('Délka (mm)').fill('600');
  await crate.getByLabel('Šířka (mm)').fill('400');
  await crate.getByLabel('Výška (mm)').fill('300');
  await crate.getByLabel(/Způsob měření/).fill('Svinovací metr');
  await crate.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('crate-dims-current')).toContainText('600 × 400 × 300 mm');

  const pkg = page.getByTestId('package-dims-form');
  await pkg.getByLabel('Délka (mm)').fill('620');
  await pkg.getByLabel('Šířka (mm)').fill('420');
  await pkg.getByLabel('Výška (mm)').fill('320');
  await pkg.getByLabel('Další obal').selectOption('CARTON');
  await pkg.getByLabel('Popis obalu').fill('Kartonový přebal');
  await pkg.getByLabel(/Způsob měření/).fill('Svinovací metr');
  await pkg.getByRole('button', { name: 'Uložit měření' }).click();
  // Saved (not the unknown state shown before): the carton with its mass still unknown.
  await expect(page.getByTestId('package-dims-current')).toContainText('Karton (Kartonový přebal)');
  await expect(page.getByTestId('package-dims-current')).toContainText('neznámá');

  // The carton weighed later: a correction of the package record, the first one stays.
  await pkg.getByLabel('Délka (mm)').fill('620');
  await pkg.getByLabel('Šířka (mm)').fill('420');
  await pkg.getByLabel('Výška (mm)').fill('320');
  await pkg.getByLabel('Další obal').selectOption('CARTON');
  await pkg.getByLabel('Popis obalu').fill('Kartonový přebal');
  await pkg.getByLabel(/Hmotnost obalu/).fill('450');
  await pkg.getByLabel(/Způsob měření/).fill('Kuchyňská váha');
  await pkg.getByLabel(/Opravit poslední záznam/).check();
  await pkg.getByLabel('Důvod opravy').fill('Karton dovážen');
  await pkg.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('package-dims-current')).toContainText('450 g');
  await page.getByTestId('package-dims-history').locator('summary').click();
  await expect(page.getByTestId('package-dims-history')).toContainText('Historie měření (2)');
  await expect(page.getByTestId('package-dims-history')).toContainText(
    'důvod opravy: Karton dovážen',
  );
  await shot(page, 'w1-02-crate-type-desktop');
});

test('the expected full crate: bottles × finished bottle + tare + carton; components not added', async ({
  page,
}) => {
  await measure(page.request, '/api/admin/catalog/components/NEW_BOTTLE/weights', {
    massG: '28.4',
    sampleVolume: null,
  });
  await measure(page.request, `/api/admin/catalog/components/${kit.pumpCode}/weights`, {
    massG: '12.3',
    sampleVolume: null,
  });
  await page.goto(`/production/catalog/products/${kit.productCode}`);
  const form = page.getByTestId('product-weight-form');
  await form.getByLabel('Hmotnost (g)').fill('372,5');
  await form.getByLabel('Počet zvážených lahví').fill('10');
  await form.getByLabel(/Způsob měření/).fill('10 hotových lahví na váze, průměr');
  await form.getByRole('button', { name: 'Uložit měření' }).click();
  await expect(page.getByTestId('product-weight-current')).toContainText('372,5 g (zváženo 10 ks)');
  // 40 × 372,5 g + 1 850 g = 16 750 g; + carton 450 g (not in the tare) = 17 200 g.
  await expect(page.getByTestId('expected-crate')).toHaveText('16,75 kg');
  await expect(page.getByTestId('expected-package')).toHaveText('17,2 kg');
  await expect(page.getByTestId('crate-expectation')).toContainText('obal přičten');
  // Components per bottle: 28,4 + 0,512 + 12,3 + 341,22 (330 ml × 103,4 g / 100 ml) — a
  // cross-check only (16,75 kg is NOT 40 × 382,432 g + tare).
  await expect(page.getByTestId('components-sum')).toContainText('382,432 g');
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.reload();
    await expect(page.getByTestId('expected-crate')).toHaveText('16,75 kg');
    await noOverflow(page);
    await shot(page, `w1-03-product-${w.name}`);
  }
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto(`/production/catalog/crate-types/${kit.crateTypeCode}`);
    await expect(page.getByTestId('crate-tare-current')).toContainText('1,85 kg');
    await noOverflow(page);
    await shot(page, `w1-04-crate-type-${w.name}`);
  }
});

test('a production operator reads the measurements but cannot record them', async ({
  browser,
  page,
}) => {
  const me = (await (await page.request.get('/api/auth/me')).json()) as {
    sites: { id: string; code: string }[];
  };
  const email = `e2e-weights-op-${Date.now()}@ayvo.test`;
  const res = await page.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: 'Operátor (vážení)',
      roles: ['PRODUCTION_OPERATOR'],
      siteIds: [me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id],
      warehouseCodes: [],
      reason: 'W1 read-only check',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const op = await context.newPage();
  await op.goto(
    `/api/auth/login?next=/production/catalog/products/${kit.productCode}&login_hint=${email}`,
  );
  await op.setViewportSize({ width: 390, height: 844 });
  await op.goto(`/production/catalog/products/${kit.productCode}`);
  await expect(op.getByTestId('expected-crate')).toHaveText('16,75 kg');
  await expect(op.getByTestId('product-weight-form')).toHaveCount(0);
  await expect(op.getByTestId('product-weight')).toContainText('Měření zapisuje vedoucí');
  await context.close();
});
