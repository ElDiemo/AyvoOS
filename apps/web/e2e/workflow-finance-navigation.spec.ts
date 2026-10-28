import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * Finance navigation (doc 042): five work pages — Přehled, Faktury hotelům, Přijaté doklady, Banka
 * a platby, Pro účetní — and Nastavení Financí apart, every one reached by clicking from the main
 * navigation, also at 390 and 320 px; the views of Faktury hotelům and Banka a platby as tabs;
 * every former URL still opens (bookmarks) with its main page active; Přijaté doklady opens on the
 * list with its search in view. Nothing overflows sideways. No data is created here.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');
const PAGES = [
  { link: 'Přehled', heading: 'Přehled Financí', url: /\/finance$/, shot: 'overview' },
  { link: 'Faktury hotelům', heading: 'Faktury', url: /\/finance\/invoices$/, shot: 'invoices' },
  {
    link: 'Přijaté doklady',
    heading: 'Přijaté doklady',
    url: /\/finance\/documents$/,
    shot: 'documents',
  },
  { link: 'Banka a platby', heading: 'Pohyby z banky', url: /\/finance\/bank$/, shot: 'bank' },
  { link: 'Pro účetní', heading: 'Export pro účetní', url: /\/finance\/exports$/, shot: 'exports' },
  {
    link: 'Nastavení Financí',
    heading: 'Naše firma a bankovní účty',
    url: /\/finance\/settings\/company$/,
    shot: 'settings',
  },
];
const VIEWS = [
  ['Faktury hotelům', 'Smlouvy a ceny', /\/finance\/billing$/, 'billing'],
  ['Faktury hotelům', 'Faktury', /\/finance\/invoices$/, null],
  ['Banka a platby', 'Platby a přiřazení', /\/finance\/payments$/, 'payments'],
  ['Banka a platby', 'Pohyby z banky', /\/finance\/bank$/, null],
] as const;
/** Former URLs (bookmarks) → the main page active there and the page's heading. */
const FORMER = [
  ['/finance/documents', 'Přijaté doklady', 'Přijaté doklady'],
  ['/finance/documents/new', 'Přijaté doklady', 'Přijmout doklad'],
  ['/finance/billing', 'Faktury hotelům', 'Smlouvy a ceny'],
  ['/finance/invoices', 'Faktury hotelům', 'Faktury'],
  ['/finance/invoices/new', 'Faktury hotelům', 'Testovací faktura'],
  ['/finance/payments', 'Banka a platby', 'Platby a přiřazení'],
  ['/finance/bank', 'Banka a platby', 'Pohyby z banky'],
  ['/finance/exports', 'Pro účetní', 'Export pro účetní'],
  ['/finance/settings/company', 'Nastavení Financí', 'Naše firma a bankovní účty'],
] as const;

test.use({ storageState: ADMIN_STATE });

const noOverflow = async (page: Page, what: string) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${what}: no horizontal overflow`,
  ).toBe(true);

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`every Finance page by clicking, its views, the list first — ${viewport.width} px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const shot = (name: string) =>
      page.screenshot({
        path: resolve(screenshots, `finance-042-${name}-${viewport.width}.png`),
        fullPage: true,
      });
    await mkdir(screenshots, { recursive: true });
    await page.goto('/');
    if (viewport.width < 768) await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
    await page
      .getByRole('navigation', { name: 'Hlavní navigace' })
      .getByRole('link', { name: 'Finance' })
      .click();
    // The module opens on its overview.
    await expect(page).toHaveURL(/\/finance$/);
    const finance = page.getByRole('navigation', { name: 'Finance' });
    const views = page.getByRole('navigation', { name: 'Zobrazení' });
    for (const p of PAGES) {
      await finance.getByRole('link', { name: p.link, exact: true }).click();
      await expect(page).toHaveURL(p.url);
      await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
      await expect(finance.getByRole('link', { name: p.link, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await noOverflow(page, p.link);
      await shot(p.shot);
    }
    // The settings are apart from the work pages, not one of them.
    await expect(page.getByTestId('aside-settings')).toBeVisible();

    // The views; the main page stays active on each.
    for (const [main, view, url, name] of VIEWS) {
      await finance.getByRole('link', { name: main, exact: true }).click();
      await views.getByRole('link', { name: view, exact: true }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole('heading', { level: 1, name: view })).toBeVisible();
      await expect(views.getByRole('link', { name: view, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(finance.getByRole('link', { name: main, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await noOverflow(page, view);
      if (name) await shot(name);
    }

    // Přijaté doklady: the list is the default screen — no form before it, the search in view;
    // the rarer filters stay closed until used.
    await finance.getByRole('link', { name: 'Přijaté doklady', exact: true }).click();
    await expect(page.getByTestId('receive-document')).toHaveCount(0);
    await expect(page.getByTestId('finance-upload')).toBeVisible();
    await expect(page.getByTestId('finance-take-over-link')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Hledat' })).toBeInViewport();
    await expect(page.getByTestId('finance-filters-more')).not.toHaveAttribute('open');
    const list = await page.getByTestId('finance-documents').boundingBox();
    expect(list!.y, 'the list starts on the first screen').toBeLessThan(viewport.height);
  });
}

test('every former Finance URL still opens with its main page active (bookmarks)', async ({
  page,
}) => {
  const finance = page.getByRole('navigation', { name: 'Finance' });
  for (const [url, main, heading] of FORMER) {
    const res = await page.goto(url);
    expect([url, res?.status()]).toEqual([url, 200]);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(finance.getByRole('link', { name: main, exact: true }), url).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});
