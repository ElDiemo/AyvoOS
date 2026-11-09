import { expect, test } from '@playwright/test';
import { noOverflow } from './dispatch-setup';
import { shot } from './sales-setup';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * "Změnit heslo" (staff) in the browser: reached from Zabezpečení účtu, checked in the browser
 * (length, confirmation) and refused by the server without the right password and code — the e2e
 * administrator signs in through the test identity fixture and has no native password, so the
 * success path is tested against the real API in native-auth.e2e. 390 px without sideways scroll.
 */
test('the change-password form: reachable, validated, a refusal shown; 390 px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account/security');
  await page.getByRole('link', { name: 'Změnit heslo' }).click();
  await expect(page).toHaveURL(/\/account\/password$/);
  await page.locator('[name=current-password]').fill('Nejake soucasne heslo 1');
  await page.locator('[name=new-password]').fill('Nove dlouhe heslo AYVO 1');
  await page.locator('[name=new-password-again]').fill('Nove dlouhe heslo AYVO 2');
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Změnit heslo' }).click();
  await expect(page.getByTestId('change-password-error')).toContainText('se liší');
  await page.locator('[name=new-password-again]').fill('Nove dlouhe heslo AYVO 1');
  await page.getByRole('button', { name: 'Změnit heslo' }).click();
  await expect(page.getByTestId('change-password-error')).toContainText(/nesouhlasí|Příliš mnoho/);
  await expect(page.getByTestId('change-password-done')).toHaveCount(0);
  await noOverflow(page);
  await shot(page, 'staff-change-password-390');
});
