import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_FILE_STORAGE_DIR } from '../playwright.config';

/**
 * Výroba → Bedny (doc 025 A1) on the real built app, a fresh database and synthetic data:
 * registering physical crates, a label size that is too small, the computed QR size, the
 * preview, printing, the list with search, the detail with history, a reprint with the same QR
 * URL, the anonymous public crate page, phone width, per-site isolation — and stock that never
 * moves. Screenshots go to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';
const E2E_DE_SITE_ID = '01990000-0000-7000-8000-0000000000e2';
const TYPE = 'CRATE-E2E-40';
let codes: string[] = [];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

/** Simulated disk failure of the e2e API's file storage: every directory read-only (or back). */
function storageWritable(writable: boolean, dir = E2E_FILE_STORAGE_DIR) {
  chmodSync(dir, writable ? 0o750 : 0o550);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) storageWritable(writable, join(dir, entry.name));
  }
}

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: `horizontal overflow on ${what}` },
    )
    .toBeLessThanOrEqual(0);
}

async function stockSnapshot(page: Page) {
  const get = async (path: string) => (await page.request.get(path)).text();
  return [
    await get('/api/admin/inventory/movements'),
    await get('/api/admin/inventory/lots?item=NEW_BOTTLE&available=false'),
    await get('/api/admin/goods-receipts'),
  ];
}

let stockBefore: string[];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await context.newPage();
  stockBefore = await stockSnapshot(page);
  // The shared crate type of the owner's example (catalogue data, synthetic code).
  const res = await page.request.post('/api/admin/catalog/crate-types', {
    data: {
      requestId: crypto.randomUUID(),
      code: TYPE,
      name: 'Vratná bedna 40 (E2E)',
      capacity: 40,
      categoryCodes: ['HAND_SOAP', 'SHOWER_GEL'],
      reason: 'typ bedny pro E2E',
    },
  });
  expect([201, 409]).toContain(res.status());
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await context.newPage();
  expect(await stockSnapshot(page)).toEqual(stockBefore);
  await context.close();
});

test('registers crates and prints their QR labels at an entered size', async ({ page }) => {
  await page.goto('/production/crates');
  await expect(page.getByRole('heading', { name: 'Bedny' })).toBeVisible();
  await page.getByRole('link', { name: 'Evidovat nové bedny' }).click();
  await expect(page).toHaveURL(/\/production\/crates\/new$/);

  const form = page.getByTestId('register-crates');
  await form.getByRole('button', { name: 'Zaevidovat bedny' }).click();
  await expect(page.getByTestId('form-errors')).toBeVisible();
  // Focus is on the first invalid field (the type is preselected when only one exists).
  await expect(form.locator('[aria-invalid="true"]').first()).toBeFocused();
  await form.getByLabel('Typ bedny').selectOption(TYPE);
  await form.getByLabel('Počet beden').fill('3');
  await shot(page, 'crates-register-form');
  await form.getByRole('button', { name: 'Zaevidovat bedny' }).click();

  const done = page.getByTestId('registration-done');
  await expect(done).toContainText('zaevidováno 3 bedny');
  codes = await done.getByTestId('registered-codes').locator('a').allInnerTexts();
  expect(codes).toHaveLength(3);
  for (const code of codes) expect(code).toMatch(/^AYV-C-\d{6}$/);

  const print = page.getByTestId('print-labels');
  await print.getByLabel('Šířka štítku (mm)').fill('20');
  await print.getByLabel('Výška štítku (mm)').fill('20');
  await expect(page.getByTestId('label-size-note')).toContainText('nevejde');
  await print.getByLabel('Šířka štítku (mm)').fill('100');
  await print.getByLabel('Výška štítku (mm)').fill('50');
  await expect(page.getByTestId('label-size-note')).toContainText('QR kód bude mít');
  await expect(page.getByTestId('label-size-note')).toContainText('není fyzicky ověřená');
  const preview = print.getByRole('link', { name: 'Otevřít náhled' });
  const previewHref = await preview.getAttribute('href');
  expect(previewHref).toContain('widthMm=100&heightMm=50');
  const previewPdf = await page.request.get(previewHref!);
  expect(previewPdf.status()).toBe(200);
  expect(previewPdf.headers()['content-type']).toBe('application/pdf');
  await shot(page, 'crates-registered-print');

  await print.getByRole('button', { name: 'Vytvořit PDF (3 štítky)' }).click();
  const result = page.getByTestId('print-result');
  await expect(result).toContainText(/Tisková úloha PJ-\d{6} je připravená/);
  await expect(result).toContainText('DEV - NOT FOR PRODUCTION');
  const download = page.waitForEvent('download');
  await result.getByTestId('download-pdf').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^PJ-\d{6}_crates_100x50mm_3-labels\.pdf$/);
  expect(
    readFileSync((await file.path())!)
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
  await shot(page, 'crates-print-done');
});

test('lists the crates with honest state and location, and finds one by number', async ({
  page,
}) => {
  await page.goto('/production/crates');
  for (const code of codes) {
    const row = page.getByTestId(`crate-${code}`);
    await expect(row).toContainText(`${TYPE} · kapacita 40`);
    await expect(row).toContainText('Bez evidovaného oběhu');
    await expect(row).toContainText('Neevidováno');
  }
  await shot(page, 'crates-list');
  const number = String(Number(codes[1]!.slice('AYV-C-'.length)));
  await page.getByLabel('Hledat kód bedny').fill(number);
  await page.getByRole('button', { name: 'Filtrovat' }).click();
  await expect(page.getByTestId('crates').locator('li')).toHaveCount(1);
  await expect(page.getByTestId(`crate-${codes[1]}`)).toBeVisible();
  await page.getByLabel('Hledat kód bedny').fill('nic');
  await page.getByRole('button', { name: 'Filtrovat' }).click();
  await expect(page.getByText('Žádná bedna neodpovídá filtru.')).toBeVisible();
});

test('reprints one crate label: a new job, the same QR URL, recorded history', async ({ page }) => {
  await page.goto(`/production/crates/${codes[0]}`);
  await expect(page.getByTestId('crate-circulation')).toHaveText('Bez evidovaného oběhu');
  await expect(page.getByTestId('crate-location')).toHaveText('Neevidováno');
  const url = await page.getByTestId('crate-qr-url').innerText();
  expect(url).toMatch(/^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByTestId('crate-history')).toContainText('Bedna zaevidována');
  await expect(page.getByTestId('crate-print-jobs').locator('li')).toHaveCount(1);

  const print = page.getByTestId('print-labels');
  await print.getByLabel('Šířka štítku (mm)').fill('60');
  await print.getByLabel('Výška štítku (mm)').fill('60');
  await print.getByRole('button', { name: 'Vytvořit PDF (1 štítek)' }).click();
  await expect(page.getByTestId('print-result')).toContainText('je připravená');
  await expect(page.getByTestId('crate-print-jobs').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('crate-print-jobs')).toContainText('60 × 60 mm');
  await expect(
    page.getByTestId('crate-history').getByText('Vytvořena tisková úloha QR štítku'),
  ).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('crate-qr-url')).toHaveText(url);
  await shot(page, 'crate-detail');

  // The QR target: only "a returnable AYVO crate" — no code, site or contents.
  await page.goto(url);
  await expect(page.getByTestId('public-crate')).toHaveText('Returnable AYVO crate');
  await expect(page.locator('body')).not.toContainText(codes[0]!);
  await expect(page.locator('body')).not.toContainText('E2E');
  await shot(page, 'crate-public-page');
});

test('a failed print job survives a reload and is rendered again as the same job', async ({
  page,
}) => {
  await page.goto(`/production/crates/${codes[2]}`);
  const list = page.getByTestId('print-job-list');
  const jobsBefore = await list.locator('li').count();
  const print = page.getByTestId('print-labels');
  await print.getByLabel('Šířka štítku (mm)').fill('80');
  await print.getByLabel('Výška štítku (mm)').fill('40');
  storageWritable(false);
  try {
    await print.getByRole('button', { name: 'Vytvořit PDF (1 štítek)' }).click();
    await expect(page.getByTestId('print-result')).toContainText(/Generování PJ-\d{6} selhalo/);
  } finally {
    storageWritable(true);
  }
  const failedCode = /PJ-\d{6}/.exec(await page.getByTestId('print-result').innerText())![0];

  // Reload / come back later: the stored job, not the form's memory, offers the recovery.
  await page.reload();
  const row = page.getByTestId(`print-job-${failedCode}`);
  await expect(row.getByTestId('print-job-status')).toHaveText('Generování selhalo');
  await expect(list.locator('li')).toHaveCount(jobsBefore + 1);
  await shot(page, 'crate-print-job-failed');
  await row.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(row.getByTestId('print-job-status')).toHaveText('Vygenerováno');
  await expect(row.getByRole('link', { name: 'Stáhnout PDF' })).toBeVisible();
  // The same job: no new print job, no new crate.
  await expect(list.locator('li')).toHaveCount(jobsBefore + 1);
  const crates = (await (await page.request.get('/api/admin/crates?pageSize=100')).json()) as {
    total: number;
  };
  expect(crates.total).toBe(codes.length);
});

test('works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/production/crates');
  await expect(page.getByTestId(`crate-${codes[0]}`)).toBeVisible();
  await noOverflow(page, 'crate list');
  await shot(page, 'crates-list-mobile');
  await page.goto(`/production/crates/${codes[0]}`);
  await expect(page.getByTestId('crate-history')).toBeVisible();
  await noOverflow(page, 'crate detail');
  await shot(page, 'crate-detail-mobile');
  await page.goto('/production/crates/new');
  await noOverflow(page, 'crate registration');
});

test('shows another site none of these crates', async ({ page }) => {
  expect(
    (
      await page.request.post('/api/auth/active-site', { data: { siteId: E2E_DE_SITE_ID } })
    ).status(),
  ).toBe(200);
  try {
    await page.goto('/production/crates');
    for (const code of codes) await expect(page.getByTestId(`crate-${code}`)).toHaveCount(0);
    // The page streams (loading state), so the not-found answer is its content, not the status.
    await page.goto(`/production/crates/${codes[0]}`);
    await expect(page.getByRole('heading', { name: 'Stránka nenalezena' })).toBeVisible();
    expect((await page.request.get(`/api/admin/crates/${codes[0]}`)).status()).toBe(404);
  } finally {
    expect(
      (
        await page.request.post('/api/auth/active-site', { data: { siteId: INITIAL_SITE_ID } })
      ).status(),
    ).toBe(200);
  }
});
