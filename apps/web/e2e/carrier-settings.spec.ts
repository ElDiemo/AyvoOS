import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Správa systému → Provozovny → detail → Dopravci a expedice (doc 029 §9) on the built app. The
 * e2e API talks to a SIMULATED PPL API (apps/api/test/support/fake-ppl.ts) — never to PPL. ADMIN
 * saves incomplete settings (the blockers are explained), prefills the sender from the site and
 * checks it, verifies the connection (token + service list, nothing created), chooses a verified
 * service and ZPL at 203 dpi; the settings are then complete. The page never contains the
 * credentials or the API URL; the operator never reaches it. Screenshots (AYVO_SCREENSHOT_DIR)
 * only after the real content is shown.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const FAKE_SECRET = 'e2e-fake-ppl-secret-never-shown';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

async function openMainSite(page: Page) {
  await page.goto('/admin/sites');
  await page.getByRole('link', { name: 'Přerov 1' }).click();
  await page.waitForURL(/\/admin\/sites\/[0-9a-f-]{36}$/);
  return page.getByTestId('carrier-settings');
}

test('ADMIN sets up PPL for a site: incomplete → verified → complete; nothing secret shown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const card = await openMainSite(page);
  await expect(card.getByRole('heading', { name: 'Dopravci a expedice' })).toBeVisible();
  await expect(card.getByTestId('carrier-problems')).toContainText('Není vybrané připojení');
  await expect(card.getByTestId('carrier-verify')).toBeDisabled();
  await shot(card.page(), 'carrier-01-empty');

  // Connection: the TEST environment, credentials only as "nastaveno".
  await card.getByTestId('carrier-connection').selectOption('PPL_TEST');
  await expect(card.getByTestId('carrier-settings-test-environment')).toHaveText(
    'Testovací prostředí',
  );
  await expect(card.getByTestId('carrier-credentials')).toContainText('nastaveno');
  await expect(card.getByTestId('carrier-credentials')).not.toContainText('nenastaveno');

  // Sender prefilled from the site — to be checked; the main site has no address yet.
  await card.getByTestId('carrier-prefill').click();
  await expect(card).toContainText('Předvyplněné údaje zkontrolujte');
  await expect(card.getByTestId('carrier-sender-name')).toHaveValue('Přerov 1');
  await card.getByTestId('carrier-sender-name').fill('AYVO Přerov');
  await card.getByTestId('carrier-sender-street').fill('Průmyslová 1');
  await card.getByTestId('carrier-sender-city').fill('Přerov');
  await card.getByTestId('carrier-sender-postalCode').fill('75002');
  await card.getByTestId('carrier-sender-country').fill('CZ');
  await card.getByTestId('carrier-sender-contact').fill('Expedice');
  await card.getByTestId('carrier-sender-phone').fill('+420 581 000 000');
  await card.getByTestId('carrier-sender-email').fill('expedice@ayvo.test');
  await card.getByTestId('carrier-enabled').check();
  // No service before verification; saving incomplete settings is allowed.
  await expect(card.getByTestId('carrier-product')).toBeDisabled();
  await card.getByTestId('carrier-save').click();
  await expect(card.getByTestId('carrier-message')).toHaveText('Nastavení uloženo.');
  await expect(card.getByTestId('carrier-problems')).toContainText('Připojení nebylo ověřeno.');
  await expect(card.getByTestId('carrier-problems')).toContainText('Není vybraná služba PPL.');

  // Verification: token + service list from the simulated PPL; nothing created.
  await card.getByTestId('carrier-verify').click();
  await expect(card.getByTestId('carrier-message')).toContainText('Připojení funguje');
  await expect(card.getByTestId('carrier-verified')).toContainText('Ověřeno');
  // The API's list is what PPL offers, not what the contract allows: nothing is chosen by itself
  // (PPL support 2026-10-21, doc 029 §5) — the service is set explicitly per site.
  await expect(card.getByTestId('carrier-message')).toContainText('smluvní dostupnost');
  await expect(card.getByTestId('carrier-product')).toHaveValue('');
  await expect(card.getByTestId('carrier-product-contract')).toContainText('nikdy nevybírá sama');
  await card.getByTestId('carrier-product').selectOption('SIM-A');
  // No format or resolution here: PDF and ZPL come from PPL, the resolution from the printer.
  await expect(card.getByTestId('carrier-label-format')).toHaveCount(0);
  await expect(card.getByTestId('carrier-label-formats')).toContainText('ZPL');
  await card.getByTestId('carrier-label-layout').selectOption('A4');
  await card.getByTestId('carrier-save').click();
  await expect(card.getByTestId('carrier-problems')).toContainText(
    'Nastavení je úplné – nové přepravy této provozovny mohou použít PPL.',
  );
  await expect(page.getByTestId('site-audit')).toContainText('Ověření připojení k dopravci');
  await expect(page.getByTestId('site-audit')).toContainText('Změna nastavení dopravce');

  // Nothing secret or technical in the page.
  const html = await page.content();
  expect(html).not.toContain(FAKE_SECRET);
  expect(html).not.toContain('myapi2');
  expect(html).not.toMatch(/access_token|Bearer/);
  await shot(page, 'carrier-02-complete-desktop');

  // A changed connection invalidates the verification (only after saving it again).
  await page.reload();
  await expect(card.getByTestId('carrier-product')).toHaveValue('SIM-A');
  await expect(card.getByTestId('carrier-label-layout')).toHaveValue('A4');

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(card.getByTestId('carrier-problems')).toContainText('Nastavení je úplné');
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
  }
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'carrier-03-complete-phone');
});

test('ADMIN enters connection credentials: write-only, never shown back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin/carriers');
  const card = page.getByTestId('connection-PPL_TEST');
  await expect(card).toContainText('Testovací prostředí');
  await expect(page.getByTestId('connection-PPL_TEST-state')).toHaveText(
    'nastaveno · ze serverového souboru',
  );
  // The simulated server's own (fake) account, now entered in the administration.
  await page.getByTestId('connection-PPL_TEST-client-id').fill('e2e-fake-ppl-client');
  const secret = page.getByTestId('connection-PPL_TEST-secret');
  await expect(secret).toHaveAttribute('type', 'password');
  await secret.fill(FAKE_SECRET);
  await page.getByTestId('connection-PPL_TEST-reason').fill('Synthetic browser test');
  await page.getByTestId('connection-PPL_TEST-save').click();
  await expect(card).toContainText('Přístupové údaje uloženy.');
  await expect(page.getByTestId('connection-PPL_TEST-state')).toHaveText(
    'nastaveno · zadáno v administraci',
  );
  await expect(secret).toHaveValue('');
  await page.reload();
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await shot(page, 'carrier-04-connections');
  // The site still uses it — same account, so the verification stays valid.
  const site = await openMainSite(page);
  await expect(site.getByTestId('carrier-credentials')).toContainText('zadáno v administraci');
  await expect(site.getByTestId('carrier-problems')).toContainText('Nastavení je úplné');
});

test('the operator never sees the carrier settings', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/operator.json' });
  const page = await ctx.newPage();
  const res = await page.request.get('/api/admin/sites');
  expect(res.status()).toBe(403);
  await page.goto('/admin/sites');
  await expect(page.getByTestId('carrier-settings')).toHaveCount(0);
  expect((await page.request.get('/api/admin/carrier-connections')).status()).toBe(403);
  await page.goto('/admin/carriers');
  await expect(page.getByTestId('connection-PPL_TEST')).toHaveCount(0);
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await ctx.close();
});
