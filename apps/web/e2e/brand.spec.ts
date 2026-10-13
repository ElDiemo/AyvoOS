import { expect, test } from '@playwright/test';

test('the official logo loads in the desktop sidebar and mobile drawer', async ({ page }) => {
  await page.goto('/');
  const desktop = page.locator('aside').getByTestId('brand-logo');
  await expect(desktop).toBeVisible();
  const logo = desktop.getByRole('img', { name: 'AYVO', exact: true });
  await expect(logo).toHaveAttribute('src', '/brand/ayvo-wordmark.svg');
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(3386);
  await expect(page.locator('aside').getByRole('link', { name: 'AYVO OS' })).toHaveAttribute(
    'href',
    '/',
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /\/icon\.svg/);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
  const drawer = page.getByRole('dialog', { name: 'Hlavní navigace' });
  await expect(drawer.getByRole('img', { name: 'AYVO', exact: true })).toBeVisible();
  await expect(drawer.getByTestId('environment-badge')).toHaveText('DEV');
  const size = await drawer.evaluate((element) => ({
    content: element.scrollWidth,
    viewport: element.clientWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('sign-in and access messages use the same logo without a session', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/login', '/forbidden', '/account-inactive', '/session-expired']) {
      await page.goto(path);
      const logo = page.getByRole('img', { name: 'AYVO', exact: true });
      await expect(logo).toBeVisible();
      await expect
        .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(3386);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      ).toBe(false);
    }
  }
  await context.close();
});
