import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const U = { email: `e2e-kalk-${tag}@ayvo.test`.toLowerCase(), name: 'Klára Obchodnice' };
// An ISO test currency of this run: never a real price, independent of other runs' prices.
const CUR = `X${tag
  .replace(/[^A-Z]/g, 'Q')
  .slice(0, 2)
  .padEnd(2, 'Q')}`;

/**
 * Orientační cena and the calculator (doc 060 §D): the sales manager sets a price per room and
 * month (with what it includes); a salesperson sees rooms × price monthly and yearly, exact, on
 * the prospect; a salesperson never opens the price page; 390 px.
 */
test('the manager sets the price; the salesperson calculates on the prospect (390 px)', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: U.email,
        displayName: U.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E kalkulace)',
      },
    }),
  );
  const m = await admin.newPage();
  await m.goto('/sales');
  await m
    .getByRole('navigation', { name: 'Obchod' })
    .getByRole('link', { name: 'Orientační cena' })
    .click();
  await m.getByTestId('price-currency').fill(CUR);
  await m.getByTestId('price-amount').fill('0');
  await m.getByTestId('price-note').fill('bez DPH, za pokoj a měsíc (test)');
  await m.getByRole('button', { name: 'Uložit novou cenu' }).click();
  await expect(m.getByTestId('price-error')).toBeVisible();
  await m.getByTestId('price-amount').fill('320,50');
  await m.getByRole('button', { name: 'Uložit novou cenu' }).click();
  await expect(m.getByTestId(`price-current-${CUR}`)).toContainText('320,50');
  await admin.close();

  const page = await signIn(browser, U.email);
  const d = await json<ProspectDetail>(
    await page.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Kalkulace ${tag}`, { roomsEstimate: 42 }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${d.code}`);
  const calc = page.getByTestId(`calculator-${CUR}`);
  // 42 × 320,50 = 13 461,00 monthly; × 12 = 161 532,00.
  await expect(calc.getByTestId(`calculator-monthly-${CUR}`)).toHaveText(`13 461,00 ${CUR}`);
  await expect(calc.getByTestId(`calculator-yearly-${CUR}`)).toHaveText(`161 532,00 ${CUR}`);
  await page.getByTestId('calculator-rooms').fill('7');
  await expect(calc.getByTestId(`calculator-monthly-${CUR}`)).toHaveText(`2 243,50 ${CUR}`);
  await expect(calc).toContainText('bez DPH, za pokoj a měsíc (test)');
  await noOverflow(page);
  await shot(page, 'sales-calculator-390');
  await page.goto('/sales/prices');
  await expect(page).toHaveURL(/\/forbidden/);
  await page.context().close();
});
