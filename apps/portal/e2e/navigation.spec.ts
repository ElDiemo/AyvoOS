import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const shot = async (page: Page, name: string) => {
  const dir = process.env.PORTAL_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}-${page.viewportSize()!.width}.png`),
    fullPage: true,
  });
};
const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

/**
 * The portal's main navigation (owner 2026-11-10): Moje hotely, Dodávky and Smlouvy of every hotel
 * of the account, Faktury; one hotel's deliveries unavailable says so in its own section; the
 * AYVO icon in the browser tab.
 */
test.describe('hotel portal: navigation and icon', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { deliveriesMode: 'ok' });
  });

  test('Dodávky and Smlouvy of all hotels from the main navigation', async ({ page }) => {
    await signIn(page);
    const nav = page.getByRole('navigation', { name: 'Hlavní navigace' });
    await nav.getByRole('link', { name: 'Dodávky' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dodávky' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dodávky' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const section = page.locator('[data-testid^=all-deliveries-]');
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('heading', { name: 'Hotel Portál E2E' })).toBeVisible();
    await expect(section.getByTestId('deliveries-in-progress')).toContainText('Na cestě');
    await noSideways(page);
    await shot(page, 'all-deliveries');
    await control(page, { deliveriesMode: 'down' });
    await page.reload();
    await expect(section).toContainText('Dodávky tohoto hotelu se teď nepodařilo načíst.');
    await nav.getByRole('link', { name: 'Smlouvy' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Smlouvy' })).toBeVisible();
    await expect(
      page.getByTestId('all-contracts').getByRole('heading', { name: 'Hotel Portál E2E' }),
    ).toBeVisible();
    await noSideways(page);
    await shot(page, 'all-contracts');
  });

  test('the AYVO icon in the browser tab', async ({ page }) => {
    await page.goto('/login');
    const href = await page.locator('link[rel=icon]').first().getAttribute('href');
    expect(href).toMatch(/icon/);
    const icon = await page.request.get(href!);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('svg');
  });
});
