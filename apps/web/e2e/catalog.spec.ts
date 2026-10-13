import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Výroba → Produkty a receptury (issue #17) on the real built app, a fresh database and synthetic
 * data: first set-up from an empty catalogue, drafts, activation, a new version, the material
 * calculation, refusals, permissions, a conflicting activation, a lost response, unsaved changes,
 * product rename/archive — and stock that never moves. Screenshots of the real screens are written
 * to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const PRODUCT = 'SOAP-330';
const VERSION_URL = (v: number) => `/production/catalog/products/${PRODUCT}/recipes/${v}`;
const SHOTS = process.env.AYVO_SCREENSHOT_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // A viewport as tall as the page (fullPage would repeat the sticky shell inside the image).
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      {
        message: `horizontal overflow on ${what}`,
      },
    )
    .toBeLessThanOrEqual(0);
}

/** Everything about stock the admin can read: must be identical before and after (doc 023). */
async function stockSnapshot(page: Page) {
  const get = async (path: string) => (await page.request.get(path)).text();
  // New catalogue items appear in the stock overview with nothing on hand — that is not stock.
  const stock = JSON.parse(await get('/api/admin/inventory/stock')) as {
    items: { item: { code: string }; onHand: string }[];
  };
  return [
    JSON.stringify(stock.items.filter((s) => s.onHand !== '0').map((s) => [s.item.code, s.onHand])),
    await get('/api/admin/inventory/movements'),
    await get('/api/admin/inventory/lots?item=NEW_BOTTLE&available=false'),
    await get('/api/admin/goods-receipts'),
  ];
}

async function createComponent(
  page: Page,
  c: {
    kind: string;
    name: string;
    code: string;
    unit?: string;
    category?: string;
    lot?: boolean;
    capacity?: string;
  },
) {
  await page.goto('/production/catalog/components/new');
  const form = page.getByTestId('component-form');
  await form.getByLabel('Druh').selectOption({ label: c.kind });
  await form.getByLabel('Název').fill(c.name);
  await form.getByLabel('Kód').fill(c.code);
  if (c.unit) await form.getByLabel('Základní jednotka').selectOption(c.unit);
  if (c.category) await form.getByLabel('Určeno pro kategorii').selectOption({ label: c.category });
  if (c.lot === false) await form.getByLabel('Sledovat po šaržích').uncheck();
  if (c.capacity !== undefined) await form.getByLabel('Kapacita obalu (lahví)').fill(c.capacity);
  await form.getByLabel('Důvod (povinný)').fill('první nastavení katalogu');
  await form.getByRole('button', { name: 'Založit komponentu' }).click();
  await expect(page).toHaveURL(/\/production\/catalog\/components\?created=/);
  await expect(page.getByTestId('success')).toContainText(c.name);
}

async function createCrateType(page: Page, code: string, name: string, capacity: string) {
  await page.goto('/production/catalog/crate-types/new');
  const form = page.getByTestId('crate-type-form');
  await form.getByLabel('Název').fill(name);
  await form.getByLabel('Kód').fill(code);
  await form.getByLabel('Kapacita (lahví)').fill(capacity);
  await form.getByLabel('Tekuté mýdlo').check();
  await form.getByLabel('Důvod (povinný)').fill('typ vratné bedny');
  await form.getByRole('button', { name: 'Založit typ bedny' }).click();
  await expect(page.getByTestId('success')).toContainText(name);
}

/** Opens a dialog action, fills the reason and confirms. */
async function confirmIn(page: Page, dialogId: string, confirm: string, reason: string) {
  const dialog = page.getByTestId(dialogId);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Důvod (povinný)').fill(reason);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function row(page: Page, kind: string, item: string | null, quantity?: string) {
  const labels: Record<string, string> = {
    NEW_BOTTLE: 'Lahev',
    LABEL_MEDIA: 'Etiketa',
    BULK_LIQUID: 'Kapalina',
    PUMP: 'Pumpička',
  };
  const editor = page.getByTestId('recipe-editor');
  if (item !== null)
    await editor.getByLabel(`${labels[kind]} – Položka`).selectOption({ label: item });
  if (quantity !== undefined) await editor.getByLabel(`${labels[kind]} – Množství`).fill(quantity);
}

async function saveDraft(page: Page, reason: string) {
  const editor = page.getByTestId('recipe-editor');
  await editor.getByLabel('Důvod (povinný)').fill(reason);
  await editor.getByRole('button', { name: 'Uložit koncept' }).click();
  await expect(page.getByTestId('recipe-saved')).toHaveText('Koncept byl uložen (nová revize).');
  await expect(editor.getByTestId('unsaved-badge')).toHaveCount(0);
}

async function calculate(page: Page, bottles: string) {
  const calc = page.getByTestId('calculator');
  await calc.getByLabel('Počet hotových lahví').fill(bottles);
  await calc.getByRole('button', { name: 'Spočítat' }).click();
  await expect(calc.getByTestId('calc-result')).toBeVisible();
  return calc;
}

let stockBefore: string[];

test('first set-up: components, crate types, product and an incomplete draft that says what is missing', async ({
  page,
}) => {
  stockBefore = await stockSnapshot(page);
  await page.goto('/production/catalog');
  await expect(page.getByTestId('catalog-scope')).toHaveText(
    'Katalog platí pro celou firmu. Zásoby patří jednotlivým provozovnám. Tyto změny nepřijímají ani nespotřebovávají materiál.',
  );
  await expect(page.getByText('Zatím žádné produkty.')).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Výroba' })
      .getByRole('link', { name: 'Produkty a receptury' }),
  ).toHaveAttribute('aria-current', 'page');
  await shot(page, '01-products-empty-desktop');

  // The form explains and enforces the rules before the API does.
  await page.goto('/production/catalog/components/new');
  const form = page.getByTestId('component-form');
  await expect(form.getByLabel('Sledovat po šaržích')).toBeChecked();
  await expect(form.getByLabel('Sledovat po šaržích')).toBeDisabled();
  await form.getByLabel('Druh').selectOption({ label: 'Kapalina' });
  await expect(form.getByLabel('Základní jednotka')).toHaveValue('ml');
  await form.getByRole('button', { name: 'Založit komponentu' }).click();
  await expect(form.getByTestId('form-errors')).toContainText('Formulář obsahuje');
  await expect(form.getByText('Kapalina a etiketa musí mít kategorii produktu.')).toBeVisible();
  await expect(form.getByLabel('Název')).toBeFocused();
  await shot(page, '02-component-form-errors-desktop');

  await createComponent(page, {
    kind: 'Lahev (tělo lahve)',
    name: 'Skleněná lahev 330 ml',
    code: 'GLASS-330',
  });
  await createComponent(page, {
    kind: 'Etiketa',
    name: 'Etiketa tekuté mýdlo',
    code: 'LABEL-SOAP',
    category: 'Tekuté mýdlo',
  });
  await createComponent(page, {
    kind: 'Kapalina',
    name: 'Tekuté mýdlo – náplň',
    code: 'LIQ-SOAP',
    unit: 'ml',
    category: 'Tekuté mýdlo',
  });
  await createComponent(page, {
    kind: 'Kapalina',
    name: 'Sprchový gel – náplň',
    code: 'LIQ-GEL',
    unit: 'ml',
    category: 'Sprchový gel',
  });
  await createComponent(page, {
    kind: 'Pumpička',
    name: 'Pumpička černá',
    code: 'PUMP-BLACK',
    lot: false,
  });
  await createComponent(page, {
    kind: 'Obal (přepravní)',
    name: 'Přepravní krabice',
    code: 'BOX',
    lot: false,
  });
  await expect(page.getByTestId('component-BOX')).toContainText('Neznámá');
  await shot(page, '03-components-desktop');

  await createCrateType(page, 'CRATE-40', 'Vratná bedna 40', '40');
  await createCrateType(page, 'CRATE-24', 'Malá bedna 24', '24');
  await expect(page.getByTestId('crate-types')).toContainText('Vratná bedna 40');

  await page.goto('/production/catalog/products/new');
  const product = page.getByTestId('product-form');
  await product.getByLabel('Název').fill('Tekuté mýdlo 330 ml');
  await product.getByLabel('Kód').fill(PRODUCT);
  await product.getByLabel('Kategorie').selectOption({ label: 'Tekuté mýdlo' });
  await product.getByLabel('Nominální obsah').fill('330');
  await product.getByLabel('Důvod (povinný)').fill('nový produkt');
  await product.getByRole('button', { name: 'Založit produkt' }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${PRODUCT}\\?created=1`));
  await expect(page.getByTestId('product-name')).toHaveText('Tekuté mýdlo 330 ml');

  await page.getByRole('button', { name: 'Nový prázdný koncept' }).click();
  await confirmIn(page, 'new-draft-dialog', 'Založit koncept', 'první kusovník');
  await expect(page).toHaveURL(new RegExp(`${VERSION_URL(1)}$`));
  await expect(page.getByTestId('recipe-missing')).toHaveText(
    'Pro aktivaci chybí: lahev, etiketa, kapalina, pumpička, typ bedny',
  );

  // Only compatible, active items are offered (no shower-gel liquid for hand soap).
  const liquidOptions = await page
    .getByTestId('recipe-editor')
    .getByLabel('Kapalina – Položka')
    .locator('option')
    .allTextContents();
  expect(liquidOptions.join('|')).toContain('Tekuté mýdlo – náplň');
  expect(liquidOptions.join('|')).not.toContain('Sprchový gel');

  await row(page, 'NEW_BOTTLE', 'Skleněná lahev 330 ml (GLASS-330)');
  await row(page, 'BULK_LIQUID', 'Tekuté mýdlo – náplň (LIQ-SOAP)', '330');
  await expect(page.getByTestId('unit-BULK_LIQUID')).toHaveText('ml');
  await expect(page.getByTestId('recipe-summary')).toContainText(
    'Kapalina: nic → Tekuté mýdlo – náplň 330 ml',
  );
  // Invalid quantity and missing reason: Czech errors, nothing saved.
  await row(page, 'BULK_LIQUID', null, '330,1234');
  await page.getByTestId('recipe-editor').getByRole('button', { name: 'Uložit koncept' }).click();
  await expect(page.getByTestId('recipe-editor').getByTestId('form-errors')).toBeVisible();
  await expect(
    page.getByTestId('recipe-editor').getByText('Vyplňte důvod (alespoň 3 znaky).'),
  ).toBeVisible();
  await row(page, 'BULK_LIQUID', null, '330');
  await saveDraft(page, 'lahev a náplň');
  await expect(page.getByTestId('recipe-missing')).toHaveText(
    'Pro aktivaci chybí: etiketa, pumpička, typ bedny',
  );
  // Incomplete: activation is explained, not offered.
  await expect(page.getByRole('button', { name: 'Aktivovat' })).toBeDisabled();
  await expect(page.getByTestId('activate-blocked')).toHaveText(
    'Aktivovat lze jen kompletní a uložený koncept.',
  );
  await expect(page.getByTestId('calc-incomplete')).toBeVisible();
});

test('unsaved draft changes are guarded; a completed draft activates as V1 and calculates exactly', async ({
  page,
}) => {
  await page.goto(VERSION_URL(1));
  await row(page, 'LABEL_MEDIA', 'Etiketa tekuté mýdlo (LABEL-SOAP)', '1');
  await expect(page.getByTestId('unsaved-badge')).toHaveText('Neuložené změny');
  // Leaving asks; "continue" keeps the draft.
  await page.getByRole('link', { name: '← Tekuté mýdlo 330 ml' }).click();
  const guard = page.getByTestId('unsaved-dialog');
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Pokračovat v úpravách' }).click();
  await expect(page).toHaveURL(new RegExp(`${VERSION_URL(1)}$`));
  await expect(page.getByTestId('recipe-summary')).toContainText('Etiketa');
  // Activation waits for the save.
  await expect(page.getByTestId('actions-blocked')).toHaveText(
    'Nejdřív uložte nebo zahoďte neuložené změny.',
  );
  // While the screen differs from the saved draft, nothing may copy or archive it.
  await expect(page.getByRole('button', { name: 'Nová verze z této' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Archivovat verzi' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Aktivovat' })).toBeDisabled();
  // Pieces are whole: 1,5 pumps are refused (unit scale), nothing is rounded.
  await row(page, 'PUMP', 'Pumpička černá (PUMP-BLACK)', '1,5');
  await page.getByTestId('recipe-editor').getByLabel('Důvod (povinný)').fill('pokus');
  await page.getByTestId('recipe-editor').getByRole('button', { name: 'Uložit koncept' }).click();
  await expect(
    page
      .getByTestId('recipe-editor')
      .getByText('Tato jednotka se počítá celými kusy – zadejte celé kladné číslo.'),
  ).toBeVisible();
  await expect(page.getByTestId('recipe-title')).toBeVisible();
  await expect(page.getByText('Revize 2')).toBeVisible(); // nothing was saved
  await row(page, 'PUMP', 'Pumpička černá (PUMP-BLACK)', '1');
  await page
    .getByTestId('recipe-editor')
    .getByLabel('Typ bedny')
    .selectOption({ label: 'Vratná bedna 40 (CRATE-40) – kapacita (lahví) 40' });
  await shot(page, '04-recipe-editor-unsaved-desktop');
  await saveDraft(page, 'kompletní kusovník');
  await expect(page.getByTestId('recipe-missing')).toHaveText('Kusovník je kompletní.');
  // After saving nothing asks any more.
  await page.getByRole('link', { name: '← Tekuté mýdlo 330 ml' }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${PRODUCT}$`));
  await expect(page.getByTestId('unsaved-dialog')).toBeHidden();

  await page.goto(VERSION_URL(1));
  await page.getByRole('button', { name: 'Aktivovat' }).click();
  await expect(page.getByTestId('recipe-dialog-text')).toHaveText(
    'Verze V1 produktu „Tekuté mýdlo 330 ml“ se stane aktivní. Žádná jiná verze není aktivní.',
  );
  await confirmIn(page, 'recipe-dialog', 'Aktivovat', 'schválený kusovník');
  await expect(page.getByTestId('recipe-title')).toContainText('Aktivní');
  await expect(page.getByTestId('recipe-editor')).toHaveCount(0);
  await expect(page.getByText('Tato verze je jen pro čtení. Změna = nová verze.')).toBeVisible();

  const calc = await calculate(page, '40');
  await expect(calc.getByTestId('total-NEW_BOTTLE')).toHaveText('40 ks');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('13 200 ml');
  await expect(calc.getByTestId('total-PUMP')).toHaveText('40 ks');
  await expect(calc.getByTestId('total-LABEL_MEDIA')).toHaveText('40 ks');
  await expect(calc.getByTestId('calc-crates')).toContainText('1 × Vratná bedna 40 (kapacita 40)');
  await expect(calc.getByTestId('calc-crates')).toContainText('Plných beden: 1');
  await expect(calc.getByTestId('calc-crates')).toContainText('Všechny bedny jsou plné.');
  await calculate(page, '41');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('13 530 ml');
  await expect(calc.getByTestId('calc-crates')).toContainText('2 × Vratná bedna 40');
  await expect(calc.getByTestId('calc-crates')).toContainText('Plných beden: 1');
  await expect(calc.getByTestId('calc-crates')).toContainText('Poslední bedna: 1 lahev');
  await expect(calc.getByTestId('partial-warning')).toBeVisible();
  await calculate(page, '1 000 000');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('330 000 000 ml');
  await calculate(page, '41');
  await shot(page, '05-recipe-active-calculation-desktop');
  await calc.getByLabel('Počet hotových lahví').fill('1,5');
  await calc.getByRole('button', { name: 'Spočítat' }).click();
  await expect(calc.getByText('Zadejte celé číslo 1–1 000 000.')).toBeVisible();
  await expect(calc.getByTestId('calc-result')).toHaveCount(0); // no totals of another number
});

test('a new version from V1 replaces it; V1 stays archived, unchanged and calculable', async ({
  page,
}) => {
  await page.goto(VERSION_URL(1));
  await page.getByRole('button', { name: 'Nová verze z této' }).click();
  await confirmIn(page, 'new-draft-dialog', 'Založit koncept', 'menší náplň');
  await expect(page).toHaveURL(new RegExp(`${VERSION_URL(2)}$`));
  await expect(page.getByTestId('recipe-missing')).toHaveText('Kusovník je kompletní.');
  await row(page, 'BULK_LIQUID', null, '300');
  await page
    .getByTestId('recipe-editor')
    .getByLabel('Typ bedny')
    .selectOption({ label: 'Malá bedna 24 (CRATE-24) – kapacita (lahví) 24' });
  await saveDraft(page, 'menší náplň a menší bedna');
  await page.getByRole('button', { name: 'Aktivovat' }).click();
  await expect(page.getByTestId('recipe-dialog-text')).toHaveText(
    'Verze V2 produktu „Tekuté mýdlo 330 ml“ se stane aktivní. Dosud aktivní V1 se archivuje.',
  );
  await confirmIn(page, 'recipe-dialog', 'Aktivovat', 'nová receptura');
  await expect(page.getByTestId('recipe-title')).toContainText('Aktivní');
  // Another capacity and quantity: nothing is hard-coded.
  const calc = await calculate(page, '50');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('15 000 ml');
  await expect(calc.getByTestId('calc-crates')).toContainText('3 × Malá bedna 24 (kapacita 24)');
  await expect(calc.getByTestId('calc-crates')).toContainText('Plných beden: 2');
  await expect(calc.getByTestId('calc-crates')).toContainText('Poslední bedna: 2 lahve');

  await page.goto(VERSION_URL(1));
  await expect(page.getByTestId('recipe-title')).toContainText('Archivovaná');
  await expect(page.getByTestId('recipe-view').locator('[data-kind="BULK_LIQUID"]')).toContainText(
    '330 ml',
  );
  const old = await calculate(page, '40');
  await expect(old.getByTestId('total-BULK_LIQUID')).toHaveText('13 200 ml');
  await expect(old.getByText('Počítá se z této (historické) verze.')).toBeVisible();

  await page.goto(`/production/catalog/products/${PRODUCT}`);
  await expect(page.getByTestId('version-2')).toContainText('Aktivní');
  await expect(page.getByTestId('version-2')).toContainText('Vychází z V1');
  await expect(page.getByTestId('version-1')).toContainText('Archivovaná');
  await shot(page, '06-product-detail-desktop');
});

test('a concurrently changed active version is a conflict — never overwritten or retried', async ({
  page,
}) => {
  // V3 = a copy of V2, saved but not active; the page is opened while V2 is active.
  const created = await page.request.post(`/api/admin/catalog/products/${PRODUCT}/recipes`, {
    data: { requestId: crypto.randomUUID(), reason: 'souběh', basedOnVersion: 2 },
  });
  expect(created.status()).toBe(201);
  await page.goto(VERSION_URL(3));
  await page.getByRole('button', { name: 'Aktivovat' }).click();
  await expect(page.getByTestId('recipe-dialog-text')).toContainText(
    'Dosud aktivní V2 se archivuje.',
  );
  // Meanwhile someone else archives V2.
  const archived = await page.request.post(
    `/api/admin/catalog/products/${PRODUCT}/recipes/2/archive`,
    {
      data: { requestId: crypto.randomUUID(), reason: 'někdo jiný' },
    },
  );
  expect(archived.status()).toBe(200);
  await confirmIn(page, 'recipe-dialog', 'Aktivovat', 'pokus o aktivaci');
  await expect(page.getByTestId('active-changed')).toContainText(
    'Aktivní verze se mezitím změnila',
  );
  const product = (await (
    await page.request.get(`/api/admin/catalog/products/${PRODUCT}`)
  ).json()) as {
    activeVersion: number | null;
  };
  expect(product.activeVersion).toBeNull(); // nothing was activated behind the user's back
  await page.getByRole('button', { name: 'Načíst aktuální stav' }).click();
  await page.getByRole('button', { name: 'Aktivovat' }).click();
  await expect(page.getByTestId('recipe-dialog-text')).toContainText(
    'Žádná jiná verze není aktivní.',
  );
  await confirmIn(page, 'recipe-dialog', 'Aktivovat', 'aktivace po kontrole');
  await expect(page.getByTestId('recipe-title')).toContainText('Aktivní');
});

test('a lost response and a double click create exactly one product', async ({ page }) => {
  const ids: string[] = [];
  let first = true;
  await page.route('**/api/admin/catalog/products', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push((route.request().postDataJSON() as { requestId: string }).requestId);
    if (first) {
      first = false;
      await route.fetch(); // the server creates it…
      return route.abort('connectionreset'); // …but the answer never arrives
    }
    return route.continue();
  });
  await page.goto('/production/catalog/products/new');
  const form = page.getByTestId('product-form');
  await form.getByLabel('Název').fill('Sprchový gel 330 ml');
  await form.getByLabel('Kód').fill('GEL-330');
  await form.getByLabel('Kategorie').selectOption({ label: 'Sprchový gel' });
  await form.getByLabel('Nominální obsah').fill('330');
  await form.getByLabel('Důvod (povinný)').fill('nový produkt');
  await form.getByRole('button', { name: 'Založit produkt' }).dblclick();
  await expect(form.getByTestId('form-errors')).toContainText('nevíme, jestli se změna uložila');
  await form.getByRole('button', { name: 'Založit produkt' }).click();
  await expect(page).toHaveURL(/\/products\/GEL-330\?created=1/);
  // The double click sent nothing extra; the retry reused the attempt's request id.
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  const all = (await (await page.request.get('/api/admin/catalog/products')).json()) as {
    code: string;
  }[];
  expect(all.filter((p) => p.code === 'GEL-330')).toHaveLength(1);
});

test('product name correction and archiving through the API rules', async ({ page }) => {
  await page.goto(`/production/catalog/products/${PRODUCT}`);
  const rename = page.getByTestId('rename-product');
  await rename.getByLabel('Název').fill('Tekuté mýdlo 330 ml (bez parfému)');
  await rename.getByLabel('Důvod (povinný)').fill('upřesnění názvu');
  await rename.getByRole('button', { name: 'Opravit název' }).click();
  await expect(rename.getByTestId('success')).toHaveText('Název byl opraven.');
  await expect(page.getByTestId('product-name')).toHaveText('Tekuté mýdlo 330 ml (bez parfému)');
  await expect(page.getByTestId('product-code')).toHaveText(PRODUCT);

  // Archiving with an active version is refused and points to it.
  await page.getByRole('button', { name: 'Archivovat produkt' }).click();
  await confirmIn(page, 'archive-product-dialog', 'Archivovat', 'konec výroby');
  await expect(page.getByTestId('archive-blocked')).toContainText('Produkt má aktivní kusovník V3');
  await page.getByRole('link', { name: 'Otevřít aktivní verzi' }).click();
  await expect(page).toHaveURL(new RegExp(`${VERSION_URL(3)}$`));
  await page.getByRole('button', { name: 'Archivovat verzi' }).click();
  await confirmIn(page, 'recipe-dialog', 'Archivovat verzi', 'konec výroby');
  await expect(page.getByTestId('recipe-title')).toContainText('Archivovaná');

  await page.goto(`/production/catalog/products/${PRODUCT}`);
  await page.getByRole('button', { name: 'Archivovat produkt' }).click();
  await confirmIn(page, 'archive-product-dialog', 'Archivovat', 'konec výroby');
  await expect(page.getByTestId('product-status')).toHaveText('Archivovaný');
  await expect(page.getByText('Produkt je archivovaný: historie je jen pro čtení.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nový prázdný koncept' })).toHaveCount(0);
  // History stays readable and calculable.
  await page.goto(VERSION_URL(1));
  const calc = await calculate(page, '40');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('13 200 ml');
  await expect(page.getByRole('button', { name: 'Nová verze z této' })).toHaveCount(0);
});

async function signInAs(browser: Browser, admin: Page, email: string, roles: string[]) {
  const res = await admin.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: email.split('@')[0],
      roles,
      siteIds: [],
      warehouseCodes: [],
      reason: 'catalogue role test',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/&login_hint=${email}`);
  await expect(page.getByTestId('current-user')).toBeVisible();
  return { context, page };
}

async function customRole(admin: Page, code: string, permissions: string[]) {
  const res = await admin.request.post('/api/admin/identity/roles', {
    data: {
      code,
      name: code,
      description: 'catalogue test role',
      permissions,
      copiedFrom: null,
      reason: 'catalogue role test',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test('catalog:read alone sees the catalogue and nothing operational; writes are refused', async ({
  browser,
  page,
}) => {
  await customRole(page, 'E2E_CATALOG_READER', ['catalog:read']);
  const { context, page: reader } = await signInAs(browser, page, 'e2e-catalog-reader@ayvo.test', [
    'E2E_CATALOG_READER',
  ]);
  // The home page and the navigation lead straight to the catalogue.
  await expect(reader.getByTestId('module-catalog')).toBeVisible();
  await reader.getByRole('link', { name: 'Výroba', exact: true }).first().click();
  await expect(reader).toHaveURL(/\/production\/catalog$/);
  const production = reader.getByRole('navigation', { name: 'Výroba' });
  await expect(production.getByRole('link')).toHaveText(['Produkty a receptury']);
  await expect(reader.getByRole('link', { name: 'Nový produkt' })).toHaveCount(0);
  await reader.goto(VERSION_URL(1));
  await expect(reader.getByRole('button', { name: 'Aktivovat' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Archivovat verzi' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Nová verze z této' })).toHaveCount(0);
  const calc = await calculate(reader, '40');
  await expect(calc.getByTestId('total-BULK_LIQUID')).toHaveText('13 200 ml');
  for (const path of [
    '/production',
    '/bottles',
    '/label-templates',
    '/production/label-activation',
    '/production/catalog/products/new',
    '/production/catalog/components/new',
    '/production/catalog/crate-types/new',
    '/warehouse/stock',
  ]) {
    await reader.goto(path);
    await expect(reader, path).toHaveURL(/\/forbidden$/);
  }
  const write = await reader.request.post('/api/admin/catalog/products', {
    data: {
      requestId: crypto.randomUUID(),
      code: 'X-1',
      name: 'x',
      categoryCode: 'HAND_SOAP',
      nominalQuantity: '1',
      nominalUnitCode: 'ml',
      reason: 'pokus',
    },
  });
  expect(write.status()).toBe(403);
  await context.close();
});

test('managing without catalog:recipe_approve cannot activate; no catalog:read cannot open it', async ({
  browser,
  page,
}) => {
  await customRole(page, 'E2E_CATALOG_EDITOR', ['catalog:read', 'catalog:product_manage']);
  const { context, page: editor } = await signInAs(browser, page, 'e2e-catalog-editor@ayvo.test', [
    'E2E_CATALOG_EDITOR',
  ]);
  await editor.goto('/production/catalog/products/GEL-330');
  await editor.getByRole('button', { name: 'Nový prázdný koncept' }).click();
  await confirmIn(editor, 'new-draft-dialog', 'Založit koncept', 'koncept gelu');
  await expect(editor).toHaveURL(/\/products\/GEL-330\/recipes\/1$/);
  await expect(editor.getByTestId('recipe-editor')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Aktivovat' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Archivovat verzi' })).toHaveCount(0);
  const activate = await editor.request.post(
    '/api/admin/catalog/products/GEL-330/recipes/1/activate',
    {
      data: { requestId: crypto.randomUUID(), reason: 'pokus', expectedActiveVersion: null },
    },
  );
  expect(activate.status()).toBe(403);
  await context.close();

  const { context: c2, page: warehouse } = await signInAs(
    browser,
    page,
    'e2e-no-catalog@ayvo.test',
    ['WAREHOUSE_OPERATOR'],
  );
  await warehouse.goto('/production/catalog');
  await expect(warehouse).toHaveURL(/\/forbidden$/);
  await c2.close();
});

test('screens fit 320–1440 px; stock and the ledger never moved', async ({ page }) => {
  const pages = [
    ['products', '/production/catalog'],
    ['components', '/production/catalog/components'],
    ['crate-types', '/production/catalog/crate-types'],
    ['product', `/production/catalog/products/${PRODUCT}`],
    ['recipe', VERSION_URL(1)],
    ['draft', '/production/catalog/products/GEL-330/recipes/1'],
    ['new-component', '/production/catalog/components/new'],
    ['new-crate-type', '/production/catalog/crate-types/new'],
    ['new-product', '/production/catalog/products/new'],
  ] as const;
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of pages) {
      await page.goto(path);
      // Wait for the real content (not the streaming skeleton) before measuring.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('catalog-scope')).toBeVisible();
      await noOverflow(page, `${name} at ${width}px`);
      if (width === 390 && ['products', 'recipe', 'draft', 'components'].includes(name)) {
        if (name === 'recipe') await calculate(page, '41');
        await shot(page, `07-${name}-mobile-390`);
      }
    }
  }
  expect(await stockSnapshot(page)).toEqual(stockBefore);
});
