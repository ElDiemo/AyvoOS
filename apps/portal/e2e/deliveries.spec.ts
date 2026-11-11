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

const stubState = async (page: Page) =>
  (await (await page.request.get(`${STUB}/__state`)).json()) as {
    hotelId: string;
    foreignHotelId: string;
    fleetIds: string[];
  };

/**
 * "Dodávky", hotel-first (owner 2026-11-11), against the core stub (which orders a session sees,
 * and their states, is tested against the real core in the API suite): the list is one short line
 * per hotel — the next real order with its state and planned ship day, the next plan day without
 * an order apart from it, "Zobrazit dodávky" — and a hotel's own page shows its current orders
 * (items on demand), its 60-day plan set apart and its delivered history folded. Real states only;
 * a passed ship day is never "Na cestě"; no delivery date is ever invented.
 */
test.describe('hotel portal: deliveries, hotel-first', () => {
  test.beforeEach(async ({ page }) => {
    await control(page, { resetProfile: true, fleet: false });
  });
  test.afterEach(async ({ page }) => {
    await control(page, { fleet: false, deliveriesMode: 'ok' });
  });

  test('three hotels as on DEV: one line each — next order, next plan day, one empty state', async ({
    page,
  }) => {
    await control(page, { fleet: true });
    await signIn(page);
    const [abc, bellevue, lipa] = (await stubState(page)).fleetIds as [string, string, string];
    await page
      .getByRole('navigation', { name: 'Hlavní navigace' })
      .getByRole('link', { name: 'Dodávky' })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dodávky');
    const rows = page.getByTestId('deliveries-hotels').getByRole('listitem');
    await expect(rows).toHaveCount(3);

    const a = page.getByTestId(`deliveries-hotel-${abc}`);
    await expect(a.getByRole('heading', { level: 2 })).toHaveText('Hotel ABC (syntetický)');
    await expect(a.getByTestId('row-order')).toContainText('Naplánováno');
    await expect(a.getByTestId('row-order')).toContainText('plánované odeslání');
    await expect(a.getByTestId('row-order')).toContainText('+ 3 další objednávky');
    await expect(a.getByTestId('row-plan')).toContainText('Orientačně');
    await expect(a.getByTestId('row-plan')).toContainText('zatím bez objednávky');

    const b = page.getByTestId(`deliveries-hotel-${bellevue}`);
    await expect(b.getByTestId('row-order')).toContainText('Připravujeme k odeslání');
    await expect(b.getByTestId('row-plan')).toContainText('Bez plánovaného termínu');

    const c = page.getByTestId(`deliveries-hotel-${lipa}`);
    await expect(c.getByTestId('row-empty')).toHaveText('Žádná objednávka ani plán zásobování.');
    await expect(c.getByTestId('row-order')).toHaveCount(0);
    await expect(c.getByTestId('row-plan')).toHaveCount(0);

    // Short: no order is listed on this page, only the hotels; each leads to its own deliveries.
    await expect(page.getByTestId(/^order-/)).toHaveCount(0);
    for (const [id, name] of [
      [abc, 'Hotel ABC (syntetický)'],
      [bellevue, 'Hotel Bellevue (syntetický)'],
      [lipa, 'Penzion U Lípy (syntetický)'],
    ] as const)
      await expect(page.getByRole('link', { name: `Zobrazit dodávky: ${name}` })).toHaveAttribute(
        'href',
        `/hotels/${id}/deliveries`,
      );
    await expect(page.locator('main a[href*="ppl"], main a[href*="track"]')).toHaveCount(0);
    await noSideways(page);
    await shot(page, 'deliveries-hotels');

    // By keyboard to the first hotel's deliveries.
    await page.getByRole('link', { name: 'Zobrazit dodávky: Hotel ABC (syntetický)' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel ABC (syntetický)');
  });

  test('one hotel’s deliveries: the summary, current orders with items on demand, the plan apart, the history', async ({
    page,
  }) => {
    await control(page, { fleet: true });
    await signIn(page);
    const [abc, bellevue, lipa] = (await stubState(page)).fleetIds as [string, string, string];
    await page.goto(`/hotels/${abc}/deliveries`);
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel ABC (syntetický)');
    const summary = page.getByTestId('detail-summary');
    await expect(summary.getByTestId('summary-order')).toContainText('Naplánováno');
    await expect(summary.getByTestId('summary-order')).toContainText('plánované odeslání');
    await expect(summary.getByTestId('summary-plan')).toContainText('Orientačně');

    const current = page.getByTestId('detail-current');
    await expect(current.getByRole('listitem')).toHaveCount(4);
    // Items on demand, by keyboard: the products, crates and bottles, the order's code.
    const second = current.getByTestId('order-ORD-000002');
    await expect(second.getByText('Sprchový gel 330 ml — 1 bedna (40 lahví)')).toBeHidden();
    await second.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(second.getByText('Sprchový gel 330 ml — 1 bedna (40 lahví)')).toBeVisible();
    await expect(second).toContainText('ORD-000002');

    // The supply plan: its own dashed section, "Orientačně", never an order or a delivery date.
    const plan = page.getByTestId('detail-plan');
    await expect(plan.getByRole('listitem')).toHaveCount(4);
    await expect(plan).toContainText('Nejsou to objednávky ani termíny doručení');
    await expect(plan).not.toContainText('ORD-');
    await expect(page.getByTestId('detail-history')).toContainText('Zatím žádná doručená zásilka.');
    // The switcher between the three hotels.
    const switcher = page.getByTestId('hotel-switcher');
    await expect(switcher.locator('[aria-current=page]')).toHaveText('Hotel ABC (syntetický)');
    await expect(
      switcher.getByRole('link', { name: 'Hotel Bellevue (syntetický)' }),
    ).toHaveAttribute('href', `/hotels/${bellevue}/deliveries`);
    await noSideways(page);
    await shot(page, 'deliveries-hotel-detail');

    await page.goto(`/hotels/${bellevue}/deliveries`);
    await expect(page.getByTestId('summary-order')).toContainText('Připravujeme k odeslání');
    await expect(page.getByTestId('detail-plan')).toContainText(
      'Plán zásobování teď na příštích 60 dní žádný termín nemá.',
    );
    await page.goto(`/hotels/${lipa}/deliveries`);
    await expect(page.getByTestId('summary-order')).toContainText('Žádná aktuální objednávka.');
    await expect(page.getByTestId('detail-current')).toContainText('Žádná aktuální objednávka.');
    await noSideways(page);
    await shot(page, 'deliveries-hotel-empty');
  });

  test('carrier states: on the way with its hand-over, the delivered history folded; a passed ship day', async ({
    page,
  }) => {
    await signIn(page);
    const id = (await stubState(page)).hotelId;
    await page.goto(`/hotels/${id}/deliveries`);
    // On the way (the carrier's hand-over) comes first; never a tracking link or parcel number.
    await expect(page.getByTestId('summary-order')).toContainText('Na cestě');
    await expect(page.getByTestId('summary-order')).toContainText('předáno dopravci 9. 11. 2026');
    await expect(page.locator('main a[href*="ppl"], main a[href*="track"]')).toHaveCount(0);
    const history = page.getByTestId('detail-history');
    await expect(history.getByTestId('order-OR-000905')).toBeHidden();
    await history.locator('summary').first().click();
    await expect(history.getByTestId('order-OR-000905')).toContainText('doručeno 29. 10. 2026');

    // The order's own ship day has passed and the carrier has reported nothing: never "Na cestě".
    await control(page, { deliveriesMode: 'late' });
    await page.reload();
    await expect(page.getByTestId('summary-order')).toContainText('Odešleme co nejdřív');
    await expect(page.getByTestId('summary-order')).not.toContainText('Na cestě');
    await expect(page.getByTestId('detail-current')).not.toContainText('2020');

    // Only plan days (no order): the plan, no order invented from it.
    await control(page, { deliveriesMode: 'plan-only' });
    await page.reload();
    await expect(page.getByTestId('summary-order')).toContainText('Žádná aktuální objednávka.');
    await expect(page.getByTestId('summary-plan')).toContainText('5. 12. 2026');

    // Paused or no plan, nothing ordered: one short line each.
    await control(page, { deliveriesMode: 'none' });
    await page.reload();
    await expect(page.getByTestId('detail-plan')).toContainText('žádný termín nemá');
    await page.goto('/deliveries');
    await expect(page.getByTestId('row-empty')).toHaveText('Žádná objednávka ani plán zásobování.');

    // Unavailable: said once, the page stays.
    await control(page, { deliveriesMode: 'down' });
    await page.reload();
    await expect(page.getByTestId('row-unavailable')).toBeVisible();
    await page.goto(`/hotels/${id}/deliveries`);
    await expect(page.getByText('Dodávky se teď nepodařilo načíst.')).toBeVisible();
    await expect(page.getByTestId('portal-hotel-name')).toBeVisible();
  });

  test('the profile’s nearest delivery and its tabs are unchanged', async ({ page }) => {
    await signIn(page);
    const id = (await stubState(page)).hotelId;
    await page.goto(`/hotels/${id}`);
    const next = page.getByTestId('profile-next-delivery');
    await expect(next).toContainText('Na cestě');
    await expect(next).toContainText('9. 11. 2026');
    const tabs = page.getByRole('navigation', { name: 'Hotel' });
    await tabs.getByRole('link', { name: 'Dodávky' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('portal-hotel-name')).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Dodávky' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('a foreign hotel’s deliveries are not found', async ({ page }) => {
    await signIn(page);
    const { foreignHotelId } = await stubState(page);
    await page.goto(`/hotels/${foreignHotelId}/deliveries`);
    await expect(page.getByRole('heading', { name: 'Nenalezeno' })).toBeVisible();
  });
});
