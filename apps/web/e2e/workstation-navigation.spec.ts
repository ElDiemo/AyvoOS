import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fillingStation, labelingSetup, releaseOwnStation } from './labeling-setup';

/**
 * Výroba = Práce · Evidence · Nastavení výroby (doc 027, issue #11): the grouped navigation with
 * the work entry, the active item brought into view on phones (UI-08), the scan field getting the
 * focus back after the navigation drawer is closed (UI-14) and "Připravit výrobu". Synthetic data;
 * screenshots go to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await releaseOwnStation(context.request);
  await context.close();
});

for (const width of [320, 390]) {
  test(`the active production page is visible in the tab strip at ${width} px (UI-08)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/production/catalog', '/label-templates', '/production/workstations']) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Výroba' });
      // Every section is on screen (a 2×2 grid on phones), none hidden sideways.
      for (const s of ['overview', 'work', 'records', 'setup']) {
        await expect(nav.getByTestId(`section-${s}`)).toBeInViewport({ ratio: 1 });
      }
      await expect(nav.getByTestId('section-setup')).toHaveAttribute('aria-current', 'true');
      const strip = nav.getByTestId('module-tabs');
      const active = strip.locator('[aria-current="page"]');
      await expect(active).toBeVisible();
      await expect
        .poll(async () => {
          const s = (await strip.boundingBox())!;
          const a = (await active.boundingBox())!;
          return a.x >= s.x - 1 && a.x + a.width <= s.x + s.width + 1;
        }, path)
        .toBe(true);
      // The page itself never scrolls sideways.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    }
    if (width === 390) await shot(page, 'nav-mobile-390');
  });
}

test('closing the navigation drawer gives the focus back to the scan field (UI-14)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await releaseOwnStation(page.request);
  const station = await fillingStation(page.request);
  await page.goto('/production/station');
  const stationField = page.getByLabel('Naskenujte QR pracoviště');
  await expect(stationField).toBeFocused();
  await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
  await page.getByRole('button', { name: 'Zavřít navigaci' }).click();
  await expect(stationField).toBeFocused();
  // The scanner's next input lands in the field.
  await page.keyboard.type(station.url);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('station-mode')).toContainText('Plnění');

  // The same inside the working station.
  const crateField = page.getByTestId('crate-scan').getByRole('textbox');
  await expect(crateField).toBeFocused();
  await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
  await page.keyboard.press('Escape'); // closing by Escape too
  await expect(crateField).toBeFocused();
  await page.keyboard.type('AYV');
  await expect(crateField).toHaveValue('AYV');
});

test('Výroba: work entry, Evidence and Nastavení; Připravit výrobu lists labelling and filling separately', async ({
  page,
}) => {
  // A product with an active recipe, its design NOT approved yet (synthetic).
  const kit = await labelingSetup(page.request, { versionId: '', approve: false });
  await page.goto('/production');
  const nav = page.getByRole('navigation', { name: 'Výroba' });
  await expect(nav.getByTestId('section-work')).toContainText('Práce');
  await shot(page, 'production-overview');
  await nav.getByTestId('section-setup').click(); // opens Připravit výrobu first
  await expect(page).toHaveURL(/\/production\/setup/);
  await page.goto(`/production/setup?product=${kit.productCode}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Připravit výrobu');
  for (const section of ['setup', 'labeling', 'filling']) {
    await expect(page.getByTestId(`readiness-${section}`)).toBeVisible();
  }
  await expect(page.getByTestId('readiness-labeling')).toContainText('připravené k tisku');
  await expect(page.getByTestId('readiness-labeling')).not.toContainText('Kapalina');
  await expect(page.getByTestId('readiness-filling')).toContainText('Kapalina na skladě');
  // No crate waits: filling materials are the active recipe's, shown as the plan for new crates.
  await expect(page.getByTestId('readiness-filling.liquid')).toContainText(
    'aktivní receptura V1 – plán pro nové bedny',
  );
  await expect(page.getByTestId('readiness-setup.warehouse')).toHaveAttribute('data-state', 'OK');
  // Concrete missing items, with the page to fix them.
  await expect(page.getByTestId('readiness-setup.recipe')).toHaveAttribute('data-state', 'OK');
  await expect(page.getByTestId('readiness-setup.design')).toHaveAttribute('data-state', 'MISSING');
  await expect(page.getByTestId('readiness-setup.design').getByRole('link')).toHaveAttribute(
    'href',
    `/production/catalog/products/${kit.productCode}#designs`,
  );
  await shot(page, 'production-setup');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await shot(page, 'production-setup-mobile');
});
