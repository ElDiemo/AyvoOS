import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, noOverflow } from './dispatch-setup';
import { OPERATOR_STATE } from '../playwright.config';

/**
 * Suppliers and goods barcodes at receiving (doc 033), on the real built app with synthetic data
 * in the recreated e2e database. ADMIN creates a foreign supplier and corrects it with a reason
 * (history kept), assigns barcodes (leading zeros, letters, several per item) and retires one;
 * a receipt is then filled with a keyboard-wedge "scanner" (the code typed + Enter): a scan only
 * selects the item, a repeated scan changes nothing, Enter never submits the receipt, unknown /
 * retired / Czech-layout / network failures keep the form and return the focus to the scan field.
 * Stock moves only when the receipt is confirmed. The warehouse supervisor sees contacts but may
 * neither correct suppliers nor manage codes.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const SUPPLIER = 'Pumpen Werk GmbH (E2E)';
const ZEROS = '0004006381333';
const ALNUM = 'PW-77/a.9';
const SECOND = '8594000000016';
const THIRD = 'PB-0003';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let supplierId = '';
const item = { code: '', name: '', id: '' };
const other = { code: '', name: '', id: '' };
const third = { name: '' };

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

/** Desktop, 390 and 320 px: no horizontal overflow; screenshots when requested. */
async function widths(page: Page, name: string) {
  for (const [width, suffix] of [
    [1280, 'desktop'],
    [390, '390'],
    [320, '320'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await shot(page, `${name}-${suffix}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function movements(page: Page) {
  return (await json<{ total: number }>(await page.request.get('/api/admin/inventory/movements')))
    .total;
}

/** A keyboard-wedge scanner: the characters, then Enter. */
async function scan(page: Page, code: string) {
  const field = page.getByLabel('Načíst kód zboží');
  await field.fill(code);
  await field.press('Enter');
}

/** A real scanner types fast into whatever has the focus, then Enter (review 033-1). */
async function scannerTypes(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press('Enter');
}

test('a foreign supplier with its address and contact; a correction keeps the history', async ({
  page,
}) => {
  await page.goto('/warehouse/suppliers');
  await page.getByRole('link', { name: 'Nový dodavatel', exact: true }).click();
  await expect(page.getByTestId('section-identity')).toBeVisible();
  await expect(page.getByTestId('section-address')).toBeVisible();
  await expect(page.getByTestId('section-contact')).toBeVisible();
  await page.getByLabel('Název', { exact: true }).fill(SUPPLIER);
  // No Czech IČO: a foreign registration number, no DIČ.
  await page.getByLabel('IČO / registrační číslo').fill('HRB 123456');
  await page.getByLabel('Ulice a číslo').fill('Teststraße 1');
  await page.getByLabel('PSČ').fill('80331');
  await page.getByLabel('Město').fill('München');
  await page.getByLabel('Země').fill('Německo');
  await page.getByLabel('Kontaktní osoba').fill('Testovací kontakt');
  await page.getByLabel('Telefon').fill('+49 89 000000');
  await page.getByLabel('E-mail').fill('objednavky@example.test');
  await widths(page, 'suppliers-01-new');
  await page.getByRole('button', { name: 'Založit dodavatele' }).click();
  await expect(page.getByTestId('form-errors')).toBeVisible();
  await expect(page.getByLabel('Země')).toBeFocused();
  await page.getByLabel('Země').fill('de');
  await expect(page.getByLabel('Země')).toHaveValue('DE');
  await page.getByRole('button', { name: 'Založit dodavatele' }).click();
  await expect(page).toHaveURL(/\/warehouse\/suppliers\/[0-9a-f-]{36}\?created=1$/);
  supplierId = page.url().match(/suppliers\/([0-9a-f-]{36})/)![1]!;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(SUPPLIER);
  await expect(page.getByTestId('supplier-identity')).toContainText('HRB 123456');
  await expect(page.getByTestId('supplier-address')).toContainText('München');
  await expect(page.getByTestId('supplier-contact')).toContainText('+49 89 000000');

  // Correction: a reason is required; the previous version stays in the history.
  await page.getByTestId('edit-supplier').click();
  await page.getByLabel('Město').fill('Augsburg');
  await page.getByLabel('PSČ').fill('86150');
  await page.getByRole('button', { name: 'Uložit novou verzi' }).click();
  await expect(page.getByTestId('form-errors')).toBeVisible();
  await page.getByLabel('Důvod').fill('sídlo se přestěhovalo podle nové faktury');
  await page.getByRole('button', { name: 'Uložit novou verzi' }).click();
  await expect(page).toHaveURL(/\?saved=1$/);
  await expect(page.getByTestId('supplier-address')).toContainText('Augsburg');
  const history = page.getByTestId('supplier-history');
  await expect(history).toContainText('Verze 2');
  await expect(history).toContainText('sídlo se přestěhovalo podle nové faktury');
  await expect(history).toContainText('Město: München → Augsburg');
  await expect(history).toContainText('Verze 1');
  await widths(page, 'suppliers-02-detail');

  // A supplier with only a name (as all suppliers before doc 033): nothing more is demanded.
  const bare = await json<{ id: string }>(
    await page.request.post('/api/admin/suppliers', {
      data: {
        requestId: crypto.randomUUID(),
        name: 'Starý dodavatel (E2E)',
        companyId: null,
        vatId: null,
      },
    }),
  );
  await page.goto(`/warehouse/suppliers/${bare.id}`);
  await expect(page.getByTestId('supplier-address')).toContainText('neuvedeno');

  await page.goto('/warehouse/suppliers');
  await page.getByLabel('Hledat dodavatele').fill('augsburg');
  await expect(page.getByTestId('supplier-row')).toHaveCount(1);
  await expect(page.getByTestId('suppliers')).toContainText(SUPPLIER);
  await page.getByLabel('Hledat dodavatele').fill('');
  await widths(page, 'suppliers-03-list');
});

test('barcodes of stock items: exact text, several per item, conflicts named, retire keeps history', async ({
  page,
}) => {
  // A second stock item: a pump from the catalogue (synthetic, e2e database only).
  await json(
    await page.request.post('/api/admin/catalog/components', {
      data: {
        requestId: crypto.randomUUID(),
        code: 'PUMP-E2E-BC',
        name: 'Pumpička černá (E2E)',
        kind: 'PUMP',
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: null,
        packageCapacity: null,
        reason: 'čárové kódy v e2e testu',
      },
    }),
  );
  const items = await json<{ id: string; code: string; name: string }[]>(
    await page.request.get('/api/admin/inventory/items'),
  );
  Object.assign(
    item,
    items.find((i) => i.code === 'NEW_BOTTLE')!,
  );
  Object.assign(
    other,
    items.find((i) => i.code === 'PUMP-E2E-BC')!,
  );
  const before = await movements(page);

  await page.goto('/warehouse/stock');
  const card = page.getByTestId(`barcodes-${item.code}`);
  await card.locator('summary').first().click();
  await expect(card).toContainText('Položka zatím nemá žádný čárový kód.');
  const field = card.getByLabel('Nový kód (načtěte čtečkou nebo opište)');
  await field.fill(ZEROS);
  await field.press('Enter');
  await expect(card.getByTestId('barcode-active')).toHaveCount(1);
  await field.fill(ALNUM);
  await card.getByRole('button', { name: 'Přiřadit kód' }).click();
  await expect(card.getByTestId('barcode-active')).toHaveCount(2);
  await expect(card.getByTestId('barcode-active').first()).toBeVisible();
  await expect(card).toContainText(ZEROS); // leading zeros kept
  await expect(card).toContainText(ALNUM);
  // Czech keyboard layout instead of digits: explained, nothing saved.
  await field.fill('ěščřžýáíé');
  await card.getByRole('button', { name: 'Přiřadit kód' }).click();
  await expect(card).toContainText('čtečka zřejmě píše s českou klávesnicí');
  await expect(card.getByTestId('barcode-active')).toHaveCount(2);

  // The same code on another item: refused, the holder named, never taken over.
  const second = page.getByTestId(`barcodes-${other.code}`);
  await second.locator('summary').first().click();
  const secondField = second.getByLabel('Nový kód (načtěte čtečkou nebo opište)');
  await secondField.fill(ZEROS);
  await second.getByRole('button', { name: 'Přiřadit kód' }).click();
  await expect(second).toContainText(`už určuje jinou skladovou položku`);
  await expect(second).toContainText(item.code);
  await secondField.fill(SECOND);
  await second.getByRole('button', { name: 'Přiřadit kód' }).click();
  await expect(second.getByTestId('barcode-active')).toHaveCount(1);

  // Retire ALNUM with a reason: it stays as history.
  await card
    .getByTestId('barcode-active')
    .filter({ hasText: ALNUM })
    .getByRole('button', { name: 'Vyřadit' })
    .click();
  const dialog = card.getByTestId('retire-barcode-dialog');
  await dialog.getByLabel('Důvod').fill('dodavatel změnil obal');
  await dialog.getByRole('button', { name: 'Vyřadit kód' }).click();
  await expect(card.getByTestId('barcode-active')).toHaveCount(1);
  await card.getByText('Vyřazené kódy (1)').click();
  await expect(card.getByTestId('barcode-retired')).toContainText('dodavatel změnil obal');
  await widths(page, 'barcodes-01-item');
  expect(await movements(page)).toBe(before); // codes never move stock
});

test('receiving with a scanner: a scan selects the item only; Enter never submits; errors keep the form', async ({
  page,
}) => {
  // A third item with a code: the target of the lookup held back during review.
  await json(
    await page.request.post('/api/admin/catalog/components', {
      data: {
        requestId: crypto.randomUUID(),
        code: 'PUMP-E2E-BC3',
        name: 'Pumpička bílá (E2E)',
        kind: 'PUMP',
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: null,
        packageCapacity: null,
        reason: 'čárové kódy v e2e testu',
      },
    }),
  );
  await json(
    await page.request.post('/api/admin/inventory/items/PUMP-E2E-BC3/barcodes', {
      data: { requestId: crypto.randomUUID(), code: THIRD },
    }),
  );
  third.name = 'Pumpička bílá (E2E)';
  const before = await movements(page);
  await page.goto('/warehouse/receipts/new');
  await page.getByRole('combobox', { name: 'Dodavatel' }).selectOption({ label: SUPPLIER });
  await page.getByLabel('Dodací list / faktura č.').fill('DL-SCAN-1');

  const result = page.getByTestId('scan-result');
  const scanField = page.getByLabel('Načíst kód zboží');
  await scan(page, ZEROS);
  await expect(result).toContainText(`Načteno: ${item.name} (${item.code})`);
  await expect(result).toContainText('Položka je na řádku 1');
  await expect(page.getByTestId('receipt-line-1').getByLabel('Položka')).toHaveValue(item.id);
  await expect(page.getByTestId('receipt-line-1')).toHaveAttribute('data-scanned', 'true');
  // The focus stays in the scan field: the next read goes there, never into a quantity.
  await expect(scanField).toBeFocused();
  await scannerTypes(page, ZEROS);
  await expect(result).toContainText('už je na řádku 1');
  await expect(page.getByTestId('receipt-line-1').getByLabel(/Množství/)).toHaveValue('');

  // The operator types the quantity by hand (slowly), then the scanner reads again while the
  // focus is still in the quantity: the read goes to the scan, the quantity stays 12.
  const qty1 = page.getByTestId('receipt-line-1').getByLabel(/Množství/);
  await qty1.click();
  await page.keyboard.type('12', { delay: 120 });
  await scannerTypes(page, ZEROS);
  await expect(qty1).toHaveValue('12');
  await expect(scanField).toBeFocused();

  // The same code again: no new line, the quantity stays.
  await scan(page, ZEROS);
  await expect(result).toContainText('už je na řádku 1');
  await expect(page.locator('[data-testid^="receipt-line-"]')).toHaveCount(1);
  await expect(page.getByTestId('receipt-line-1').getByLabel(/Množství/)).toHaveValue('12');

  // A second item adds a second line, empty for the operator.
  await scan(page, SECOND);
  await expect(page.locator('[data-testid^="receipt-line-"]')).toHaveCount(2);
  await expect(page.getByTestId('receipt-line-2').getByLabel('Položka')).toHaveValue(other.id);
  await expect(page.getByTestId('receipt-line-2').getByLabel(/Množství/)).toHaveValue('');
  await page
    .getByTestId('receipt-line-2')
    .getByLabel(/Množství/)
    .fill('3');

  // Unknown: nothing created, the manager may assign it right here.
  await scan(page, 'NEZNAMY-123');
  await expect(result).toContainText('Kód NEZNAMY-123 není přiřazen žádné skladové položce');
  await expect(page.getByTestId('scan-assign')).toBeVisible();
  await expect(scanField).toBeFocused();
  // SUP42-R1: assign it right here; afterwards the focus is back in the scan field, so the next
  // real read (typed into whatever has the focus) is not lost.
  await page
    .getByTestId('scan-assign')
    .getByRole('combobox')
    .selectOption({ label: `${item.name} (${item.code})` });
  await page.getByRole('button', { name: 'Přiřadit a použít' }).click();
  await expect(result).toContainText('už je na řádku 1');
  await expect(page.getByTestId('scan-assign')).toHaveCount(0);
  await expect(scanField).toBeFocused();
  await scannerTypes(page, SECOND);
  await expect(result).toContainText('už je na řádku 2');
  await expect(page.getByTestId('receipt-line-1').getByLabel(/Množství/)).toHaveValue('12');
  // Retired: says so.
  await scan(page, ALNUM);
  await expect(result).toContainText(`Kód ${ALNUM} byl vyřazen`);
  // A scanner typing with a Czech layout.
  await scan(page, 'ěščřžýáíé');
  await expect(result).toContainText('českou klávesnicí');
  // A bottle QR link is not a goods code.
  await scan(page, 'http://localhost:3100/q/AbCdEfGhIjKlMnOpQrStUv');
  await expect(result).toContainText('Toto je QR odkaz');

  // Network failure: the form stays, the code is back in the field, the focus too.
  await page.route('**/api/admin/inventory/barcodes/lookup**', (route) => route.abort());
  await scan(page, SECOND);
  await expect(result).toContainText('Kód se nepodařilo ověřit');
  await expect(scanField).toHaveValue(SECOND);
  await expect(scanField).toBeFocused();
  await expect(page.locator('[data-testid^="receipt-line-"]')).toHaveCount(2);
  await expect(page.getByTestId('receipt-line-1').getByLabel(/Množství/)).toHaveValue('12');
  await page.unroute('**/api/admin/inventory/barcodes/lookup**');
  await scanField.press('Enter');
  await expect(result).toContainText('už je na řádku 2');

  // None of the Enters submitted anything; nothing moved.
  await expect(page).toHaveURL(/\/warehouse\/receipts\/new$/);
  await expect(page.getByTestId('receipt-review')).toHaveCount(0);
  expect(await movements(page)).toBe(before);
  await widths(page, 'receiving-01-scanned');

  // Only the explicit confirmation receives the goods.
  await page.getByLabel('Číslo dokladu').fill('DL-SCAN-1');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'dodaci-list.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Nahrát doklad' }).click();
  await expect(page.getByTestId('receipt-documents')).toContainText('DL-SCAN-1');

  // Review 033-2: a lookup still held back when the receipt goes to review changes nothing.
  let releaseLookup!: () => void;
  const held = new Promise<void>((r) => (releaseLookup = r));
  await page.route('**/api/admin/inventory/barcodes/lookup**', async (route) => {
    await held;
    await route.continue();
  });
  await scanField.click();
  await scannerTypes(page, THIRD);
  await expect(result).toContainText('Hledám kód');
  await page.getByRole('button', { name: 'Zkontrolovat' }).click();
  const review = page.getByTestId('receipt-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('barcode-scan')).toHaveCount(0);
  const answered = page.waitForResponse('**/api/admin/inventory/barcodes/lookup**');
  releaseLookup();
  expect((await answered).status()).toBe(200);
  await page.unroute('**/api/admin/inventory/barcodes/lookup**');
  // Let the answer reach the page; nothing may change in the review.
  await page.waitForTimeout(500);
  await expect(review).not.toContainText(third.name);
  await expect(review).toContainText(`${item.name}`);
  await expect(review).toContainText('12');
  await expect(review).toContainText(`${other.name}`);
  expect(await movements(page)).toBe(before);

  await page.getByRole('button', { name: 'Potvrdit příjem' }).click();
  await expect(page).toHaveURL(/\/warehouse\/receipts\/GR-\d{6}\?created=1$/);
  await expect(page.getByTestId('line-1')).toContainText('12');
  await expect(page.getByTestId('line-2')).toContainText('3');
  await expect(page.getByTestId('line-3')).toHaveCount(0);
  expect(await movements(page)).toBe(before + 2);
});

test('the warehouse supervisor sees contacts, but neither corrects suppliers nor manages codes', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: OPERATOR_STATE });
  const page = await context.newPage();
  await page.goto(`/warehouse/suppliers/${supplierId}`);
  await expect(page.getByTestId('supplier-contact')).toContainText('Testovací kontakt');
  await expect(page.getByTestId('edit-supplier')).toHaveCount(0);
  await page.goto(`/warehouse/suppliers/${supplierId}/edit`);
  await expect(page).toHaveURL(/\/forbidden$/);

  await page.goto('/warehouse/receipts/new');
  await scan(page, 'NEZNAMY-456');
  await expect(page.getByTestId('scan-result')).toContainText('provede správce');
  await expect(page.getByTestId('scan-assign')).toHaveCount(0);
  await page.goto('/warehouse/stock');
  const card = page.getByTestId(`barcodes-${item.code}`);
  await card.locator('summary').first().click();
  await expect(card).toContainText(ZEROS);
  await expect(card.getByRole('button', { name: 'Vyřadit' })).toHaveCount(0);
  await expect(card.getByLabel('Nový kód (načtěte čtečkou nebo opište)')).toHaveCount(0);
  await context.close();
});
