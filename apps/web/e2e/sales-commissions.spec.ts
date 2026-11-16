import { expect, test } from '@playwright/test';
import type { AdminUserDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const A = { email: `e2e-provize-a-${tag}@ayvo.test`.toLowerCase(), name: `Alena Provize ${tag}` };
const C = { email: `e2e-provize-c-${tag}@ayvo.test`.toLowerCase(), name: `Cyril Provize ${tag}` };
let aId = '';

/**
 * Obchod → Provize (doc 068, PR 1a PROTOTYPE): the administrator picks a salesperson, records
 * terms with the keyboard and sees the history; a refused value is explained at its field; a
 * salesperson only reads their own terms (no form), a salesperson without terms sees the missing
 * state; 1440 and 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const u of [A, C]) {
    const created = await json<AdminUserDetail>(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'obchodník (E2E provize)',
        },
      }),
    );
    if (u === A) aId = created.id;
  }
  await admin.close();
});

test('the administrator records terms by keyboard; the history keeps every version', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await admin.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/sales');
  await page
    .getByRole('navigation', { name: 'Obchod' })
    .getByRole('link', { name: 'Provize' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Provize' })).toBeVisible();
  await page.goto(`/sales/commissions?salesperson=${aId}`);
  await expect(page.getByTestId('terms-selected')).toContainText('Chybí podmínky provize');

  // A refused value is explained at its field and nothing is sent.
  await page.getByTestId('terms-initialRate').fill('20,005');
  await page.getByTestId('terms-initialMonths').fill('24');
  await page.getByTestId('terms-maintenanceRate').fill('5');
  await page.getByTestId('terms-reason').fill('smlouva o spolupráci');
  await page.getByTestId('terms-confirm').check();
  await page.getByTestId('terms-reason').press('Tab');
  await page.keyboard.press('Space'); // the checkbox, by keyboard: unchecked again
  await page.getByTestId('terms-save').click();
  await expect(page.getByTestId('terms-initialRate')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#terms-initial-rate-error')).toBeVisible();
  await expect(page.locator('#terms-confirm-error')).toBeVisible();

  // Corrected, confirmed and sent with Enter.
  await page.getByTestId('terms-initialRate').fill('20');
  await page.getByTestId('terms-confirm').check();
  await page.getByTestId('terms-initialRate').press('Enter');
  await expect(page.getByTestId('terms-valid')).toContainText('20,00 % po 24 měsíců, potom 5,00 %');
  await expect(page.getByTestId('terms-history')).toContainText('smlouva o spolupráci');

  // A second version: the first stays in the history.
  await page.getByTestId('terms-initialRate').fill('10');
  await page.getByTestId('terms-initialMonths').fill('36');
  await page.getByTestId('terms-maintenanceRate').fill('3');
  await page.getByTestId('terms-reason').fill('nová smlouva');
  await page.getByTestId('terms-confirm').check();
  await page.getByTestId('terms-save').click();
  await expect(page.getByTestId('terms-valid')).toContainText('10,00 % po 36 měsíců, potom 3,00 %');
  await expect(page.getByTestId('terms-history').locator('tbody tr')).toHaveCount(2);
  await noOverflow(page);
  await shot(page, 'sales-commissions-admin-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await noOverflow(page);
  await shot(page, 'sales-commissions-admin-390');
  await admin.close();
});

test('a salesperson reads only their own terms; without terms the missing state', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  await page.goto('/sales/commissions');
  await expect(page.getByTestId('terms-mine')).toContainText('10,00 % po 36 měsíců');
  await expect(page.getByTestId('terms-form')).toHaveCount(0);
  await expect(page.getByTestId('terms-people')).toHaveCount(0);
  // The settings of others are not reachable even by URL.
  await page.goto(`/sales/commissions?salesperson=${aId}`);
  await expect(page.getByTestId('terms-form')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'sales-commissions-mine-390');
  await page.context().close();

  const c = await signIn(browser, C.email);
  await c.goto('/sales/commissions');
  await expect(c.getByTestId('terms-mine')).toContainText('Chybí podmínky provize');
  await c.context().close();
});
