import { expect, test, type Page } from '@playwright/test';

/**
 * AYVO OS shell and information architecture (doc 019): company functions instead of entities,
 * Warehouse and Production as separate modules, label application inside Production, real
 * redirects for old URLs, a phone drawer, no sideways scrolling. Read-only: creates no records.
 */

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: `horizontal overflow on ${what}` },
    )
    .toBeLessThanOrEqual(0);
}

test('global navigation: overview and the two operational modules only', async ({ page }) => {
  await page.goto('/');
  const main = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(main.getByRole('link')).toHaveText(['Přehled', 'Sklad', 'Výroba']);
  await expect(main.getByRole('link', { name: 'Přehled' })).toHaveAttribute('aria-current', 'page');
  // Entities are not company modules; future modules are not shown as dead links.
  for (const name of ['Lahve', 'Šablony etiket', 'Bottles', 'Label templates', 'Hotely']) {
    await expect(main.getByRole('link', { name })).toHaveCount(0);
  }
  await expect(page.getByTestId('environment-badge').first()).toHaveText('DEV');
  // The real signed-in user and sign-out; no administration without the permission.
  await expect(page.getByTestId('current-user')).toHaveText('E2E Operátor');
  await expect(page.getByRole('button', { name: 'Odhlásit' }).first()).toBeVisible();
  await expect(main.getByRole('link', { name: 'Uživatelé a role' })).toHaveCount(0);
});

test('Warehouse and Production are separate; label application belongs to Production', async ({
  page,
}) => {
  await page.goto('/warehouse');
  const warehouse = page.getByRole('navigation', { name: 'Sklad' });
  await expect(warehouse.getByRole('link')).toHaveText([
    'Přehled skladu',
    'Příjem zboží',
    'Příjmy',
    'Stav skladu',
    'Pohyby',
    'Dodavatelé',
  ]);
  await expect(warehouse.getByRole('link', { name: 'Nalepení etiket' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Přehled skladu');
  await expect(page.getByRole('navigation', { name: 'Umístění' })).toHaveText(
    /Sklad\s*\/\s*Přehled skladu/,
  );

  await page.goto('/production');
  const production = page.getByRole('navigation', { name: 'Výroba' });
  await expect(production.getByRole('link')).toHaveText([
    'Přehled výroby',
    'Lahve',
    'Šablony etiket',
    'Nalepení etiket',
  ]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Přehled výroby');
  await production.getByRole('link', { name: 'Nalepení etiket' }).click();
  await expect(page).toHaveURL(/\/production\/label-activation$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nalepení etiket');
  await expect(page.getByRole('navigation', { name: 'Sklad' })).toHaveCount(0);

  // Templates are a Production page too.
  await production.getByRole('link', { name: 'Šablony etiket' }).click();
  await expect(page).toHaveURL(/\/label-templates$/);
  await expect(
    page.getByRole('navigation', { name: 'Hlavní navigace' }).getByRole('link', { name: 'Výroba' }),
  ).toHaveAttribute('aria-current', 'page');
});

test('/warehouse is a page; the old label-application URL is a real redirect keeping the query', async ({
  request,
  browser,
}) => {
  const overview = await request.get('/warehouse', { maxRedirects: 0 });
  expect(overview.status()).toBe(200);
  for (const [from, to] of [
    ['/warehouse/labels', '/production/label-activation'],
    ['/warehouse/labels?lot=GR-000001%2F1', '/production/label-activation?lot=GR-000001%2F1'],
  ] as const) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers()['location'], from).toBe(to);
  }
  // Without client JavaScript the HTTP redirect alone gets the browser there.
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: 'e2e/.auth/operator.json',
  });
  const page = await context.newPage();
  const response = await page.goto('/warehouse/labels?x=1');
  expect(response?.status()).toBe(200);
  expect(page.url()).toMatch(/\/production\/label-activation\?x=1$/);
  await context.close();
});

test('phones use a drawer; the scanner keeps the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/production/label-activation');
  const drawer = page.getByRole('dialog', { name: 'Hlavní navigace' });
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Sklad' }).click();
  await expect(page).toHaveURL(/\/warehouse$/);
  await expect(drawer).toBeHidden();
  // The top bar stays compact: the scanner page content starts right below it.
  await page.goto('/production/label-activation');
  const top = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(top!.y).toBeLessThan(200);
});

test('no sideways scrolling and no production QR URL on the shell pages', async ({ page }) => {
  const paths = [
    '/',
    '/warehouse',
    '/warehouse/receipts/new',
    '/warehouse/receipts',
    '/warehouse/stock',
    '/warehouse/movements',
    '/warehouse/suppliers',
    '/production',
    '/production/label-activation',
    '/bottles',
    '/label-templates',
  ];
  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
      // Wide screens: the module tabs wrap instead of showing a scrollbar.
      if (width === 1280 && path !== '/') {
        const tabs = page.locator('main nav').first().locator('ul');
        const scrolls = await tabs.evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(scrolls, `tab scrollbar on ${path}`).toBe(false);
      }
      await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
    }
  }
});
