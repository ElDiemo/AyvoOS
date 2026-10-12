import { expect, test } from '@playwright/test';

/**
 * Creating a site's warehouse in the browser (doc 022 §2; v0.1: one warehouse per site, always
 * the default): a new WAREHOUSE site shows an empty state with "Vytvořit sklad", the code is
 * prefilled as `<SITE>-MAIN`, the globally taken code MAIN is refused, and after creation the
 * site has exactly one default warehouse and no further create action. The operator (no
 * sites:manage) never reaches the site administration.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const ADMIN = 'e2e/.auth/admin.json';
const OPERATOR = 'e2e/.auth/operator.json';
const SITE_CODE = 'DE-TEST-01';

test('ADMIN creates the only warehouse of a new site from its empty state', async ({ browser }) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const page = await admin.newPage();

  await page.goto('/admin/sites/new');
  await page.getByLabel('Kód (neměnný, např. CZ-PRG)').fill(SITE_CODE);
  await page.getByLabel('Název', { exact: true }).fill('Testovací sklad Německo');
  await page.getByLabel('Země (ISO, např. CZ)').fill('DE');
  await page.getByLabel('Ulice a číslo').fill('Musterstraße 1');
  await page.getByLabel('PSČ').fill('10115');
  await page.getByLabel('Město').fill('Berlin');
  await page.getByLabel('Časové pásmo (IANA, např. Europe/Prague)').fill('Europe/Berlin');
  await page.getByLabel('Jazyk (např. cs-CZ)').fill('de-DE');
  await page.getByLabel('Měna (ISO, např. CZK)').fill('EUR');
  await page.getByLabel('Sklad', { exact: true }).check();
  await page.getByLabel('Důvod (povinný)').fill('acceptance site without a warehouse');
  await page.getByRole('button', { name: 'Uložit' }).click();
  await page.waitForURL(/\/admin\/sites\/[0-9a-f-]{36}$/);

  // Empty state: warehouse operations are blocked until the warehouse exists.
  const empty = page.getByTestId('site-warehouses-empty');
  await expect(empty).toContainText('Provozovna zatím nemá sklad');
  const form = page.getByTestId('site-warehouse-form');
  await expect(form.getByRole('heading', { name: 'Nový sklad' })).toBeVisible();
  const code = form.getByLabel('Kód skladu (neměnný, jedinečný ve všech provozovnách)');
  await expect(code).toHaveValue(`${SITE_CODE}-MAIN`);
  await expect(form.getByLabel('Název skladu')).toHaveValue('Hlavní sklad');
  const create = form.getByRole('button', { name: 'Vytvořit sklad' });
  await expect(create).toBeDisabled();

  // MAIN belongs to Přerov: codes are unique across all sites.
  await code.fill('MAIN');
  await form.getByLabel('Důvod (povinný)').fill('German acceptance warehouse');
  await create.click();
  await expect(form).toContainText('Sklad s tímto kódem už existuje');

  await code.fill(`${SITE_CODE}-MAIN`);
  await create.click();
  const warehouses = page.getByTestId('site-warehouses');
  await expect(warehouses).toContainText(`Hlavní sklad ${SITE_CODE}-MAIN`);
  await expect(warehouses).toContainText('(výchozí)');
  await expect(page.getByTestId('site-warehouse-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vytvořit sklad' })).toHaveCount(0);
  await expect(page.getByTestId('site-audit')).toContainText(
    `Založení skladu · ${SITE_CODE} · ${SITE_CODE}-MAIN`,
  );
  await expect(page.getByTestId('site-audit')).toContainText('German acceptance warehouse');

  // The initial site keeps its MAIN warehouse.
  await page.goto('/admin/sites');
  await page.locator('tr[data-site="CZ-PREROV-01"]').getByRole('link').click();
  await expect(page.getByTestId('site-warehouses')).toContainText('MAIN');
  await expect(page.getByTestId('site-warehouses')).not.toContainText(SITE_CODE);
  await admin.close();
});

test('without sites:manage the site administration and its action are out of reach', async ({
  browser,
}) => {
  const operator = await browser.newContext({ storageState: OPERATOR });
  const page = await operator.newPage();
  await page.goto('/admin/sites');
  await page.waitForURL('**/forbidden');
  await expect(page.getByRole('button', { name: 'Vytvořit sklad' })).toHaveCount(0);
  await operator.close();
});
