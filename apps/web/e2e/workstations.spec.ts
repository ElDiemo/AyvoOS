import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Výroba → Pracoviště / Správa pracovišť (doc 026, A2) on the real built app, a fresh database
 * and synthetic users and stations: creating stations, the station QR label, opening a station by
 * scanning, refusals with a kept focus, the permanent banner (desktop and phone), a station in
 * use, voluntary handover, forced takeover with a reason, the former holder being told,
 * deactivation and the public QR page. Screenshots go to AYVO_SCREENSHOT_DIR when set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const FILL = 'FILL-GEL-E2E';
const LABEL = 'LABEL-E2E';
let fillUrl = '';
let pageA: Page;
let pageB: Page;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** A synthetic production operator, created by the admin and signed in via the fake provider. */
async function operatorPage(browser: Browser, admin: Page, name: string): Promise<Page> {
  const email = `e2e-ws-${name.toLowerCase()}-${Date.now()}@ayvo.test`;
  const created = await admin.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: `Operátor ${name}`,
      roles: ['PRODUCTION_OPERATOR'],
      siteIds: ['01990000-0000-7000-8000-000000000001'],
      warehouseCodes: [],
      reason: 'E2E operátor pracoviště',
    },
  });
  expect(created.status()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/production/station&login_hint=${email}`);
  await expect(page).toHaveURL(/\/production\/station$/);
  return page;
}

async function scan(page: Page, value: string) {
  const field = page.getByLabel('Naskenujte QR pracoviště');
  await expect(field).toBeFocused();
  await field.fill(value);
  await field.press('Enter');
}

test('manages stations: create, QR label', async ({ page }) => {
  await page.goto('/production/workstations');
  await expect(page.getByRole('heading', { name: 'Správa pracovišť' })).toBeVisible();
  const form = page.getByTestId('workstation-form');
  await form.getByRole('button', { name: 'Založit pracoviště' }).click();
  await expect(page.getByTestId('form-errors')).toBeVisible();

  await form.getByLabel('Název').fill('Plnicí linka gel (E2E)');
  await form.getByLabel('Kód').fill(FILL);
  await form.getByLabel('Režim').selectOption('FILLING');
  await form.getByLabel('Kategorie plnění').selectOption({ label: 'Sprchový gel' });
  await form.getByLabel('Důvod (povinný)').fill('nová plnicí linka');
  await form.getByRole('button', { name: 'Založit pracoviště' }).click();
  await expect(form).toContainText(`Pracoviště ${FILL} je založené.`);

  await form.getByLabel('Název').fill('Lepicí stůl (E2E)');
  await form.getByLabel('Kód').fill(LABEL);
  await form.getByLabel('Režim').selectOption('LABELING');
  await expect(form.getByLabel('Kategorie plnění')).toHaveCount(0);
  await form.getByLabel('Důvod (povinný)').fill('lepení etiket');
  await form.getByRole('button', { name: 'Založit pracoviště' }).click();
  await expect(page.getByTestId(`workstation-${LABEL}`)).toBeVisible();

  const row = page.getByTestId(`workstation-${FILL}`);
  await expect(row).toContainText('Plnění · Sprchový gel');
  await expect(row.getByTestId('workstation-state')).toContainText('V provozu · Volné');
  await row.getByLabel('Šířka (mm)').fill('70');
  await row.getByLabel('Výška (mm)').fill('40');
  const download = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Stáhnout PDF štítku' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`workstation_${FILL}_70x40mm.pdf`);
  expect(
    readFileSync((await file.path())!)
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
  await shot(page, 'workstations-manage');

  const list = (await (await page.request.get('/api/admin/workstations')).json()) as {
    code: string;
    qrUrl: string;
  }[];
  fillUrl = list.find((w) => w.code === FILL)!.qrUrl;
  expect(fillUrl).toMatch(/^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/);
});

test('opens a station by scanning; refusals keep the scanner focused', async ({
  page,
  browser,
}) => {
  pageA = await operatorPage(browser, page, 'A');
  await expect(pageA.getByRole('heading', { name: 'Pracoviště', level: 1 })).toBeVisible();
  await scan(pageA, 'nesmysl');
  await expect(pageA.getByTestId('station-notice')).toContainText('Toto není QR kód AYVO');
  await expect(pageA.getByLabel('Naskenujte QR pracoviště')).toHaveValue('');
  await scan(pageA, fillUrl);
  const banner = pageA.getByTestId('station-banner');
  await expect(banner.getByTestId('station-mode')).toHaveText('Plnění · Sprchový gel');
  await expect(banner).toContainText(`Plnicí linka gel (E2E) (${FILL})`);
  await expect(banner).toContainText('Operátor A');
  await expect(pageA.getByTestId('station-notice')).toContainText('je otevřené');
  await shot(pageA, 'station-open');
  await pageA.setViewportSize({ width: 390, height: 844 });
  await noOverflow(pageA);
  await expect(banner).toBeVisible();
  await shot(pageA, 'station-open-mobile');
  await pageA.setViewportSize({ width: 1280, height: 720 });

  // Reload: the server resumes the same station (no browser storage involved).
  await pageA.reload();
  await expect(pageA.getByTestId('station-banner')).toContainText(FILL);
});

test('a station in use names its holder; a voluntary handover needs no supervisor', async ({
  page,
  browser,
}) => {
  pageB = await operatorPage(browser, page, 'B');
  await scan(pageB, fillUrl);
  const busy = pageB.getByTestId('station-in-use');
  await expect(busy).toContainText('Na tomto pracovišti pracuje Operátor A.');
  await expect(busy.getByRole('button', { name: 'Převzít pracoviště' })).toHaveCount(0);
  await shot(pageB, 'station-in-use');

  await pageA.getByRole('button', { name: 'Opustit pracoviště' }).click();
  await expect(pageA.getByTestId('station-notice')).toContainText('Pracoviště jste opustili');
  await expect(pageA.getByLabel('Naskenujte QR pracoviště')).toBeFocused();

  await scan(pageB, fillUrl);
  await expect(pageB.getByTestId('station-banner')).toContainText('Operátor B');
});

test('a supervisor takes over with a reason; the former holder is told', async ({ page }) => {
  await page.goto('/production/station');
  await scan(page, fillUrl);
  const busy = page.getByTestId('station-in-use');
  await expect(busy).toContainText('Operátor B');
  await busy.getByRole('button', { name: 'Převzít pracoviště' }).click();
  const dialog = page.getByTestId('takeover-dialog');
  await dialog.getByRole('button', { name: 'Převzít pracoviště' }).click();
  await expect(dialog.getByText('Vyplňte důvod')).toBeVisible();
  await dialog.getByLabel('Důvod převzetí (povinný)').fill('Operátor B odešel z linky');
  await dialog.getByRole('button', { name: 'Převzít pracoviště' }).click();
  await expect(page.getByTestId('station-banner')).toContainText('E2E Admin');
  await expect(page.getByTestId('station-notice')).toContainText('Převzali jste pracoviště');

  await pageB.reload();
  const ended = pageB.getByTestId('station-ended');
  await expect(ended).toContainText('Pracoviště už není vaše');
  await expect(ended).toContainText('E2E Admin');
  await expect(ended).toContainText('Operátor B odešel z linky');
  await shot(pageB, 'station-taken-over');

  await page.getByRole('button', { name: 'Opustit pracoviště' }).click();
  await expect(page.getByTestId('station-notice')).toContainText('Pracoviště jste opustili');
});

test('a deactivated station refuses work; reactivation restores it', async ({ page }) => {
  await page.goto('/production/workstations');
  const row = page.getByTestId(`workstation-${FILL}`);
  await row.getByRole('button', { name: 'Vyřadit z provozu' }).click();
  const dialog = row.getByTestId('workstation-dialog');
  await dialog.getByLabel('Důvod (povinný)').fill('linka v opravě');
  await dialog.getByRole('button', { name: 'Vyřadit z provozu' }).click();
  await expect(row.getByTestId('workstation-state')).toContainText('Vyřazené z provozu');

  await pageA.goto('/production/station');
  await scan(pageA, fillUrl);
  await expect(pageA.getByTestId('station-notice')).toContainText('vyřazené z provozu');

  await row.getByRole('button', { name: 'Vrátit do provozu' }).click();
  await dialog.getByLabel('Důvod (povinný)').fill('linka opravena');
  await dialog.getByRole('button', { name: 'Vrátit do provozu' }).click();
  await expect(row.getByTestId('workstation-state')).toContainText('V provozu');

  // The station QR's public page reveals nothing internal.
  await page.goto(fillUrl);
  await expect(page.getByTestId('public-internal')).toHaveText('Internal AYVO mark');
  await expect(page.locator('body')).not.toContainText(FILL);
});
