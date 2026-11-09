import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const hotelId = async (page: Page) =>
  ((await (await page.request.get(`${STUB}/__state`)).json()) as { hotelId: string }).hotelId;
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
 * "Dodávky" against the core stub (which orders a session sees, and their states, is tested
 * against the real core in the API suite): the nearest delivery on the profile, the three groups
 * with states and times, the hotel tabs by keyboard, empty and unavailable states, a foreign hotel.
 */
test.describe('hotel portal: deliveries', () => {
  test.beforeEach(async ({ page }) => {
    await control(page, { resetProfile: true });
  });

  test('the nearest delivery on the profile; three groups; tabs; empty and unavailable', async ({
    page,
  }) => {
    await signIn(page);
    const id = await hotelId(page);
    await page.goto(`/hotels/${id}`);
    const next = page.getByTestId('profile-next-delivery');
    await expect(next).toContainText('Na cestě');
    await expect(next).toContainText('9. 11. 2026');
    await shot(page, 'profile-with-deliveries');

    // The hotel tabs by keyboard.
    const tabs = page.getByRole('navigation', { name: 'Hotel' });
    await expect(tabs.getByRole('link', { name: 'Profil' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await tabs.getByRole('link', { name: 'Dodávky' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Dodávky');
    await expect(tabs.getByRole('link', { name: 'Dodávky' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const inProgress = page.getByTestId('deliveries-in-progress');
    await expect(inProgress.getByTestId('delivery-OR-000909')).toContainText('Na cestě');
    await expect(inProgress).toContainText('Předáno dopravci');
    const planned = page.getByTestId('deliveries-planned');
    await expect(planned.getByTestId('delivery-OR-000911')).toContainText('Naplánováno');
    await expect(planned.getByTestId('delivery-OR-000911')).toContainText('Pravidelná dodávka');
    await expect(planned.getByTestId('delivery-OR-000910')).toContainText(
      'Připravujeme k odeslání',
    );
    const delivered = page.getByTestId('deliveries-delivered');
    await expect(delivered.getByTestId('delivery-OR-000905')).toContainText('Doručeno');
    await expect(delivered).toContainText('29. 10. 2026');
    await expect(delivered).toContainText('Mýdlo na ruce AYVO 330 ml · 2 bedny (80 lahví)');
    const upcoming = page.getByTestId('deliveries-upcoming');
    await expect(upcoming.getByTestId('upcoming-2026-12-05')).toContainText('5. 12. 2026');
    await expect(upcoming).toContainText('Mýdlo na ruce AYVO 330 ml · 2 bedny');
    await expect(upcoming).toContainText('Orientační dny odeslání');
    // Never a tracking link or parcel number (owner 2026-11-09).
    await expect(page.locator('main a[href*="ppl"], main a[href*="track"]')).toHaveCount(0);
    await noSideways(page);
    await shot(page, 'deliveries');

    // Only the plan ahead: the nearest delivery says it is by the plan.
    await control(page, { deliveriesMode: 'plan-only' });
    await page.goto(`/hotels/${id}`);
    await expect(next).toContainText('Podle plánu');
    await expect(next).toContainText('5. 12. 2026');
    await page.goto(`/hotels/${id}/deliveries`);

    await control(page, { deliveriesMode: 'none' });
    await page.reload();
    await expect(page.getByTestId('deliveries-planned')).toContainText(
      'Žádná naplánovaná dodávka.',
    );
    await expect(page.getByTestId('deliveries-delivered')).toContainText(
      'Zatím žádná doručená dodávka.',
    );
    await expect(page.getByTestId('deliveries-upcoming')).toContainText(
      'Žádný další den podle plánu zásobování.',
    );
    await page.goto(`/hotels/${id}`);
    await expect(next).toContainText('Žádná expedice zatím není naplánovaná.');

    await control(page, { deliveriesMode: 'down' });
    await page.goto(`/hotels/${id}/deliveries`);
    await expect(page.getByText('Dodávky se teď nepodařilo načíst.')).toBeVisible();
    await page.goto(`/hotels/${id}`);
    await expect(next).toContainText('Dodávky se teď nepodařilo načíst.');
    await expect(page.getByTestId('profile-address')).toContainText('Portálová 1');
  });

  test('a foreign hotel’s deliveries are not found', async ({ page }) => {
    await signIn(page);
    const { foreignHotelId } = (await (await page.request.get(`${STUB}/__state`)).json()) as {
      foreignHotelId: string;
    };
    await page.goto(`/hotels/${foreignHotelId}/deliveries`);
    await expect(page.getByRole('heading', { name: 'Nenalezeno' })).toBeVisible();
  });
});
