import { expect, test } from '@playwright/test';

test('home page renders AYVO OS placeholder and API status panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'AYVO OS' })).toBeVisible();
  // Works whether or not the API is running: the panel always renders a status.
  await expect(page.getByTestId('api-status')).toBeVisible();
});
