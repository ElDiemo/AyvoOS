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
 * "Moje hotely" (owner 2026-11-11): each card says whether the hotel has a current order and what
 * is happening with it (the core's state; the planned ship day, or the carrier's hand-over), the
 * next plan day without an order apart from it, and leads to the hotel's deliveries or profile.
 * A passed ship day is "Odešleme co nejdřív"; deliveries unavailable never hide the hotel.
 */
test.describe('hotel portal: Moje hotely', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { deliveriesMode: 'ok', fleet: false });
  });

  test('three hotels as on DEV: the current order, the plan day apart, the ways on', async ({
    page,
  }) => {
    await control(page, { fleet: true });
    await signIn(page);
    const cards = page.getByTestId('portal-hotels').getByRole('listitem');
    await expect(cards).toHaveCount(3);
    const abc = cards.filter({ hasText: 'Hotel ABC (syntetický)' });
    await expect(abc.getByTestId('home-next-dispatch')).toContainText('Naplánováno');
    await expect(abc.getByTestId('home-next-dispatch')).toContainText('plánované odeslání');
    await expect(abc.getByTestId('home-next-dispatch')).toContainText('+ 3 další objednávky');
    await expect(abc.getByTestId('home-next-plan')).toContainText('zatím bez objednávky');
    const bellevue = cards.filter({ hasText: 'Hotel Bellevue (syntetický)' });
    await expect(bellevue.getByTestId('home-next-dispatch')).toContainText(
      'Připravujeme k odeslání',
    );
    await expect(bellevue.getByTestId('home-next-plan')).toHaveCount(0);
    const lipa = cards.filter({ hasText: 'Penzion U Lípy (syntetický)' });
    await expect(lipa.getByTestId('home-next-dispatch')).toContainText('Žádná aktuální objednávka');
    await noSideways(page);
    await shot(page, 'home-hotels');
    await abc.getByRole('link', { name: 'Zobrazit dodávky: Hotel ABC (syntetický)' }).click();
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel ABC (syntetický)');
  });

  test('on the way, a passed ship day, only plan days, nothing, unavailable', async ({ page }) => {
    await signIn(page);
    const next = page.getByTestId('home-next-dispatch');
    await expect(next).toContainText('Na cestě');
    await expect(next).toContainText('předáno dopravci 9. 11. 2026');
    await control(page, { deliveriesMode: 'late' });
    await page.reload();
    await expect(next).toContainText('Odešleme co nejdřív');
    await expect(next).not.toContainText('2020');
    await control(page, { deliveriesMode: 'plan-only' });
    await page.reload();
    await expect(next).toContainText('Žádná aktuální objednávka');
    await expect(page.getByTestId('home-next-plan')).toContainText('5. 12. 2026');
    await control(page, { deliveriesMode: 'none' });
    await page.reload();
    await expect(next).toContainText('Žádná aktuální objednávka');
    await expect(page.getByTestId('home-next-plan')).toHaveCount(0);
    await control(page, { deliveriesMode: 'down' });
    await page.reload();
    await expect(page.getByTestId('home-dispatch-unavailable')).toBeVisible();
    await expect(page.getByTestId('portal-hotels')).toContainText('Hotel Portál E2E');
    // The profile is still one click away.
    await page.getByRole('link', { name: 'Zobrazit profil: Hotel Portál E2E' }).click();
    await expect(page.getByTestId('profile-next-delivery')).toBeVisible();
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
    await page.getByRole('link', { name: 'Zobrazit profil: Hotel Portál E2E' }).click();
    await expect(page.getByTestId('profile-next-delivery')).toBeVisible();
    await expect(page.getByTestId('hotel-switcher')).toHaveCount(0);
  });

  test('the hotel profile: the next dispatch with its products apart from the last real shipment', async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Zobrazit profil: Hotel Portál E2E' }).click();
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
