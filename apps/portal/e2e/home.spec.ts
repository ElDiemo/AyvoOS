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
 * "Moje hotely" with each hotel's dispatch at a glance (owner 2026-11-10), against the core stub:
 * the nearest planned dispatch (an order, else a plan day "Podle plánu", a passed ship day
 * "Odešleme co nejdřív"), the shipments on the way with their hand-over and the last delivery —
 * planned dispatch and delivery labelled apart; deliveries unavailable never hide the hotel.
 */
test.describe('hotel portal: dispatch on Moje hotely', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { deliveriesMode: 'ok' });
  });

  test('the nearest dispatch and the latest shipments, labelled apart', async ({ page }) => {
    await signIn(page);
    const card = page.getByTestId('portal-hotels').getByRole('listitem').first();
    await expect(card.getByTestId('home-next-dispatch')).toContainText('Připravujeme k odeslání');
    await expect(card).toContainText('Nejbližší expedice (plánované odeslání)');
    const latest = card.getByTestId('home-latest');
    await expect(latest).toContainText('Na cestě');
    await expect(latest).toContainText('předáno dopravci 9. 11. 2026');
    await expect(latest).toContainText('Poslední doručení 29. 10. 2026');
    await noSideways(page);
    await shot(page, 'home-dispatch');
    // The card still leads to the hotel.
    await card.getByRole('link').click();
    await expect(page.getByTestId('profile-next-delivery')).toBeVisible();
  });

  test('only plan days, a passed ship day, nothing, unavailable', async ({ page }) => {
    await signIn(page);
    const next = page.getByTestId('home-next-dispatch');
    await control(page, { deliveriesMode: 'plan-only' });
    await page.reload();
    await expect(next).toContainText('5. 12. 2026');
    await expect(next).toContainText('Podle plánu');
    await expect(page.getByTestId('home-latest')).toContainText('Zatím žádná zásilka.');
    await control(page, { deliveriesMode: 'late' });
    await page.reload();
    await expect(next).toContainText('Odešleme co nejdřív');
    await expect(next).not.toContainText('2020');
    await control(page, { deliveriesMode: 'none' });
    await page.reload();
    await expect(next).toContainText('Žádná expedice zatím není naplánovaná.');
    await control(page, { deliveriesMode: 'down' });
    await page.reload();
    await expect(page.getByTestId('home-dispatch-unavailable')).toBeVisible();
    await expect(page.getByTestId('portal-hotels')).toContainText('Hotel Portál E2E');
  });

  test('an account with two hotels: both on Moje hotely and a switcher on the hotel pages', async ({
    page,
  }) => {
    await control(page, { secondHotel: true });
    try {
      await signIn(page);
      await expect(page.getByTestId('portal-hotels').getByRole('listitem')).toHaveCount(2);
      const { hotelId, secondHotelId } = (await (
        await page.request.get(`${STUB}/__state`)
      ).json()) as { hotelId: string; secondHotelId: string };
      await page.goto(`/hotels/${hotelId}/deliveries`);
      const switcher = page.getByTestId('hotel-switcher');
      await expect(switcher.locator('[aria-current=page]')).toHaveText('Hotel Portál E2E');
      await expect(switcher.getByRole('link', { name: 'Hotel Druhý E2E' })).toHaveAttribute(
        'href',
        `/hotels/${secondHotelId}/deliveries`,
      );
      await noSideways(page);
      await shot(page, 'hotel-switcher');
    } finally {
      await control(page, { secondHotel: false });
    }
    // One hotel: no switcher.
    await page.goto('/');
    await page.getByTestId('portal-hotels').getByRole('link').first().click();
    await expect(page.getByTestId('profile-next-delivery')).toBeVisible();
    await expect(page.getByTestId('hotel-switcher')).toHaveCount(0);
  });

  test('the hotel profile: the next dispatch with its products apart from the last real shipment', async ({
    page,
  }) => {
    await signIn(page);
    await page.getByTestId('portal-hotels').getByRole('link').first().click();
    const card = page.getByTestId('profile-next-delivery');
    const next = card.getByTestId('next-dispatch');
    await expect(next).toContainText('Připravujeme k odeslání');
    await expect(next).toContainText('Mýdlo na ruce AYVO 330 ml · 2 bedny (80 lahví)');
    const last = card.getByTestId('last-shipment');
    await expect(last).toContainText('Na cestě');
    await expect(last).toContainText('předáno dopravci 9. 11. 2026');
    await noSideways(page);
    await shot(page, 'profile-dispatch');
    // Only plan days: the plan day with its crates, no shipment yet.
    await control(page, { deliveriesMode: 'plan-only' });
    await page.reload();
    await expect(next).toContainText('Podle plánu');
    await expect(next).toContainText('Mýdlo na ruce AYVO 330 ml · 2 bedny');
    await expect(next).not.toContainText('lahví');
    await expect(last).toContainText('Zatím žádná zásilka.');
    // A passed ship day is never shown as a date.
    await control(page, { deliveriesMode: 'late' });
    await page.reload();
    await expect(next).toContainText('Odešleme co nejdřív');
    await control(page, { deliveriesMode: 'down' });
    await page.reload();
    await expect(card).toContainText('Dodávky se teď nepodařilo načíst');
    await expect(page.getByTestId('portal-hotel-name')).toBeVisible();
  });
});
