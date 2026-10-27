import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * Finance navigation and its default screen (UI audit U1: UI-01, UI-02): every Finance page is
 * reached by clicking from the main navigation (Doklady, Export pro účetní, Bankovní pohyby, Naše
 * firma a účty), also at 320 px; Doklady opens on the list itself with its actions above it; the
 * beginning of the list is visible without scrolling past any form. No data is created here.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');
const PAGES = [
  { link: 'Doklady', heading: 'Přijaté doklady', url: /\/finance\/documents$/ },
  { link: 'Export pro účetní', heading: 'Export pro účetní', url: /\/finance\/exports$/ },
  { link: 'Bankovní pohyby', heading: 'Bankovní pohyby', url: /\/finance\/bank$/ },
  {
    link: 'Naše firma a účty',
    heading: 'Naše firma a bankovní účty',
    url: /\/finance\/settings\/company$/,
  },
];

test.use({ storageState: ADMIN_STATE });

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test(`every Finance page by clicking, the list first — ${viewport.width} px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const phone = viewport.width < 768;
    if (phone) await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
    await page
      .getByRole('navigation', { name: 'Hlavní navigace' })
      .getByRole('link', { name: 'Finance' })
      .click();
    await expect(page).toHaveURL(/\/finance\/documents$/);
    const finance = page.getByRole('navigation', { name: 'Finance' });
    for (const p of PAGES) {
      await finance.getByRole('link', { name: p.link, exact: true }).click();
      await expect(page).toHaveURL(p.url);
      await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
      await expect(finance.getByRole('link', { name: p.link, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    // Doklady: the list is the default screen — no form before it, its start in view.
    await finance.getByRole('link', { name: 'Doklady', exact: true }).click();
    await expect(page.getByTestId('receive-document')).toHaveCount(0);
    await expect(page.getByTestId('finance-upload')).toBeVisible();
    await expect(page.getByTestId('finance-take-over-link')).toBeVisible();
    const filters = await page.getByTestId('finance-filters').boundingBox();
    expect(filters, 'filters rendered').not.toBeNull();
    expect(filters!.y).toBeLessThan(viewport.height - 60);
    // The list itself starts on the first screen (at 320 × 740 at least the filters do).
    if (viewport.width >= 390) {
      const list = await page.getByTestId('finance-documents').boundingBox();
      expect(list!.y).toBeLessThan(viewport.height);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: resolve(screenshots, `finance-u1-documents-${viewport.width}.png`),
    });
    await finance.getByRole('link', { name: 'Bankovní pohyby', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bankovní pohyby' })).toBeVisible();
    await page.screenshot({
      path: resolve(screenshots, `finance-u1-bank-${viewport.width}.png`),
      fullPage: true,
    });
  });
}
