import { expect, test } from '@playwright/test';
import type { AdminUserDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const A = {
  email: `e2e-prirazeni-a-${tag}@ayvo.test`.toLowerCase(),
  name: `Alena Přiřazení ${tag}`,
};
const B = {
  email: `e2e-prirazeni-b-${tag}@ayvo.test`.toLowerCase(),
  name: `Bohdan Přiřazení ${tag}`,
};
const ids: Record<'a' | 'b', string> = { a: '', b: '' };
let hotel = { code: '', name: `Hotel Přiřazení ${tag}` };

/**
 * Obchod → Provize PR 1b (doc 068 §12): the admin attributes an existing hotel without an
 * acquisition by hand on its card (keyboard; the first paid month confirmed explicitly), then
 * changes the salesperson from a later month; each salesperson sees only their own hotels of the
 * month in the portfolio, with the bound rate or the missing terms — never an amount. 1440 and
 * 390 px without sideways scrolling. Synthetic data only.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const [key, u] of [
    ['a', A],
    ['b', B],
  ] as const) {
    const created = await json<AdminUserDetail>(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'obchodník (E2E přiřazení)',
        },
      }),
    );
    ids[key] = created.id;
  }
  // Terms only for A: B shows the missing state.
  await json(
    await admin.request.post('/api/admin/sales/commission-terms', {
      data: {
        requestId: crypto.randomUUID(),
        salespersonId: ids.a,
        expectedVersion: 0,
        initialRate: '20',
        initialMonths: 24,
        maintenanceRate: '5',
        reason: 'smlouva o spolupráci (E2E)',
        confirm: true,
      },
    }),
  );
  const me = await json<{ sites: { id: string; code: string }[] }>(
    await admin.request.get('/api/auth/me'),
  );
  hotel = {
    ...hotel,
    code: (
      await json<{ code: string }>(
        await admin.request.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name: hotel.name,
            addressLine1: 'Provizní 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 168',
            contactEmail: 'recepce@prirazeni.test',
            fulfillmentSiteId: me.sites[0]!.id,
          },
        }),
      )
    ).code,
  };
  await admin.close();
});

test('the admin attributes a hotel by hand and changes the salesperson later', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await admin.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/hotels/${hotel.code}`);
  const panel = page.getByTestId('hotel-attribution');
  await expect(panel).toContainText('Hotel zatím nikomu přiřazený není.');
  await expect(panel).toContainText('Bez zdrojové akvizice');

  await page.getByTestId('attribution-salesperson').selectOption({ label: A.name });
  await expect(page.getByTestId('attribution-terms')).toContainText(
    '20,00 % po 24 měsíců, potom 5,00 %',
  );
  await page.getByTestId('attribution-month').fill('2027-06');
  await page.getByTestId('attribution-reason').fill('stávající hotel, získala Alena');
  await page.getByTestId('attribution-confirm').check();
  // Without the explicit confirmation of the first paid month: refused at its field.
  await page.getByTestId('attribution-save').press('Enter');
  await expect(page.locator('#attribution-confirm-month-error')).toBeVisible();
  await page.getByTestId('attribution-confirm-month').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('attribution-confirm-month')).toBeChecked();
  await page.getByTestId('attribution-save').press('Enter');
  await expect(page.getByTestId('attribution-current')).toContainText(A.name);
  await expect(page.getByTestId('attribution-current')).toContainText('6/2027');
  await expect(page.getByTestId('attribution-history').locator('tbody tr')).toHaveCount(1);
  await shot(page, 'sales-attribution-card-1440');

  // A change of salesperson from September; the first paid month stays.
  await panel.getByText('Změnit obchodníka').click();
  await page.getByTestId('attribution-salesperson').selectOption({ label: B.name });
  await expect(page.getByTestId('attribution-terms')).toContainText('Chybí podmínky provize');
  await page.getByTestId('attribution-month').fill('2027-09');
  await page.getByTestId('attribution-reason').fill('předání portfolia');
  await page.getByTestId('attribution-confirm').check();
  await page.getByTestId('attribution-save').press('Enter');
  await expect(page.getByTestId('attribution-current')).toContainText(B.name);
  await expect(page.getByTestId('attribution-current')).toContainText('6/2027');
  const rows = page.getByTestId('attribution-history').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('20,00 % po 24 měsíců');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await noOverflow(page);
  await shot(page, 'sales-attribution-card-390');
  await admin.close();
});

test('each salesperson sees only their own hotels of the month, without amounts', async ({
  browser,
}) => {
  const a = await signIn(browser, A.email);
  await a.setViewportSize({ width: 1440, height: 900 });
  await a.goto('/sales/commissions?tab=portfolio&month=2027-07');
  await expect(a.getByTestId('portfolio-count')).toHaveText('1 hotel v tomto měsíci');
  const row = a.getByTestId('portfolio-rows').locator('li');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(hotel.name);
  await expect(row).toContainText('Měsíc provize 2.');
  await expect(row).toContainText('20,00 % (počáteční)');
  await expect(a.getByTestId('portfolio')).not.toContainText('Kč');
  await expect(a.getByTestId('portfolio-salesperson')).toHaveCount(0);
  await shot(a, 'sales-portfolio-1440');
  // From September the hotel is B's.
  await a.goto('/sales/commissions?tab=portfolio&month=2027-09');
  await expect(a.getByTestId('portfolio-count')).toHaveText('0 hotelů v tomto měsíci');
  await a.setViewportSize({ width: 390, height: 844 });
  await noOverflow(a);
  await a.context().close();

  const b = await signIn(browser, B.email);
  await b.setViewportSize({ width: 390, height: 844 });
  await b.goto('/sales/commissions?tab=portfolio&month=2027-09');
  await expect(b.getByTestId('portfolio-rows').locator('li')).toHaveCount(1);
  await expect(b.getByTestId('portfolio-rows')).toContainText('Chybí podmínky provize');
  await expect(b.getByTestId('portfolio-rows')).toContainText('Měsíc provize 4.');
  await noOverflow(b);
  await shot(b, 'sales-portfolio-390');
  // Another person's portfolio is not reachable by URL.
  await b.goto(`/sales/commissions?tab=portfolio&month=2027-07&salesperson=${ids.a}`);
  await expect(b.getByTestId('portfolio-count')).toHaveText('0 hotelů v tomto měsíci');
  await b.context().close();
});
