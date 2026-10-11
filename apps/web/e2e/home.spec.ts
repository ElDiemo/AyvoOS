import { expect, test } from '@playwright/test';

test('the overview shows the operational modules and the system status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Přehled' })).toBeVisible();
  await expect(page.getByTestId('module-warehouse')).toContainText('Sklad');
  await expect(page.getByTestId('module-production')).toContainText('Výroba');
  await expect(page.getByTestId('api-status')).toBeVisible();
  // Only implemented modules: no placeholders for future functions.
  for (const future of ['Hotely', 'Prodej', 'Finance', 'ESG', 'Kvalita', 'Vratky', 'Logistika']) {
    await expect(page.locator('body')).not.toContainText(future);
  }
});
