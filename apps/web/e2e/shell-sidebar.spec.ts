import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * The shared left navigation (owner 2026-10-28, a visual fix only — no route, permission or menu
 * change): rows of one height, the same insets on both sides, the active page distinct from hover
 * and keyboard focus, the DEV marker always there, the user and sign-out reachable also in a low
 * window (the navigation scrolls, never the page sideways), on a computer and in the phone drawer.
 * Screenshots: docs/screenshots/shell/sidebar-*.png.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/shell');
const SHOT = process.env.SIDEBAR_SHOT ?? 'after';

test.use({ storageState: ADMIN_STATE });

async function rows(nav: Locator) {
  const links = nav.getByRole('link');
  const boxes = [];
  for (let i = 0; i < (await links.count()); i++) boxes.push((await links.nth(i).boundingBox())!);
  return boxes;
}

async function checkSidebar(page: Page, panel: Locator, name: string) {
  const nav = panel.getByRole('navigation', { name: 'Hlavní navigace' });
  const boxes = await rows(nav);
  expect(boxes.length).toBeGreaterThan(3);
  for (const b of boxes) {
    // One row height (≈ 40–44 px) and the same inset on both sides of the panel.
    expect(b.height, `${name}: row height`).toBeGreaterThanOrEqual(40);
    expect(b.height, `${name}: row height`).toBeLessThanOrEqual(44);
  }
  const panelBox = (await panel.boundingBox())!;
  const left = boxes[0]!.x - panelBox.x;
  const right = panelBox.x + panelBox.width - (boxes[0]!.x + boxes[0]!.width);
  expect(Math.abs(left - right), `${name}: same inset left and right`).toBeLessThanOrEqual(2);
  // Every icon is decorative next to its text: each link has a readable name.
  for (const link of await nav.getByRole('link').all())
    expect((await link.innerText()).trim().length, `${name}: link text`).toBeGreaterThan(0);
  // The DEV marker stays.
  await expect(panel.getByTestId('environment-badge')).toHaveText('DEV');
  // The user, account security and sign-out are reachable (scrolled into view if needed).
  for (const target of [
    panel.getByTestId('sidebar-user'),
    panel.getByRole('link', { name: 'Zabezpečení účtu' }),
    panel.getByRole('button', { name: 'Odhlásit' }),
  ]) {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${name}: no horizontal overflow`,
  ).toBe(true);
}

for (const viewport of [
  { width: 1440, height: 900, name: 'desktop' },
  { width: 1440, height: 660, name: 'laptop' },
]) {
  test(`sidebar — ${viewport.name} ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/finance/documents');
    const panel = page.locator('aside');
    await mkdir(screenshots, { recursive: true });
    await panel.screenshot({
      path: resolve(screenshots, `sidebar-${SHOT}-${viewport.width}x${viewport.height}.png`),
    });
    const nav = panel.getByRole('navigation', { name: 'Hlavní navigace' });
    // The active module, its hover and its keyboard focus look different.
    const active = nav.getByRole('link', { name: 'Finance' });
    await expect(active).toHaveAttribute('aria-current', 'page');
    const other = nav.getByRole('link', { name: 'Sklad' });
    const style = (l: Locator) =>
      l.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.backgroundColor}|${s.boxShadow}|${s.outlineStyle}|${s.color}`;
      });
    const idle = await style(other);
    await other.hover();
    const hover = await style(other);
    expect(hover, 'hover differs from idle').not.toBe(idle);
    expect(hover, 'hover differs from the active page').not.toBe(await style(active));
    await page.mouse.move(800, 400);
    await other.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const focus = await style(other);
    expect(focus, 'keyboard focus is visible').not.toBe(idle);
    await page.locator('body').focus();
    await checkSidebar(page, panel, viewport.name);
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`phone drawer — ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/finance/documents');
    await page.getByRole('button', { name: 'Otevřít navigaci' }).click();
    const drawer = page.getByRole('dialog', { name: 'Hlavní navigace' });
    await expect(drawer).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: resolve(screenshots, `sidebar-${SHOT}-${viewport.width}x${viewport.height}.png`),
    });
    await checkSidebar(page, drawer, `drawer ${viewport.width}`);
    await drawer.getByRole('button', { name: 'Zavřít navigaci' }).click();
    await expect(drawer).toBeHidden();
  });
}
