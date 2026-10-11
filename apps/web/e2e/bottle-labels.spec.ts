import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

/**
 * Milestone 1 happy path, as an AYVO administrator does it: create the "mydlo1" label template
 * with the visual designer, register 50 bottles with it, generate and download the 50-page print
 * PDF, and open one bottle (admin detail + public passport). Runs on a fresh `ayvo_e2e` database.
 */
test.describe.configure({ mode: 'serial' });

const MM_PER_PT = 25.4 / 72;

/** The confirmed registration of BC-000001, captured in the first test for the resume test. */
let firstRegistration: { requestId: string; labelTemplateVersionId: string; quantity: number };

async function qrValues(page: Page) {
  const read = async (id: string) => Number(await page.getByTestId(id).inputValue());
  return { x: await read('qr-x'), y: await read('qr-y'), size: await read('qr-width') };
}

test('create template, register 50 bottles, print labels, inspect a bottle', async ({ page }) => {
  // 29–30: create template "mydlo1" and upload artwork.
  await page.goto('/label-templates');
  await page.getByRole('link', { name: 'Nová šablona' }).click();
  await page.getByLabel('Název šablony').fill('mydlo1');
  await page
    .getByLabel('Grafika na pozadí (SVG, PNG nebo JPEG)')
    .setInputFiles(resolve(import.meta.dirname, 'fixtures/mydlo1.svg'));

  // The SVG states 70 × 110 mm; the designer opens with a default QR placement.
  await expect(page.getByTestId('label-width')).toHaveValue('70');
  await expect(page.getByTestId('label-height')).toHaveValue('110');
  const qrBox = page.getByTestId('qr-box');
  await expect(qrBox).toBeVisible();
  const initial = await qrValues(page);
  // The preview encodes THIS environment's URL with the configured error correction —
  // never a production URL in DEV/test.
  const designerQr = page.getByTestId('qr-box').locator('svg');
  await expect(designerQr).toHaveAttribute(
    'data-qr-value',
    /^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/,
  );
  await expect(designerQr).toHaveAttribute('data-qr-level', 'Q');

  // 31: drag the QR with the pointer…
  await page.getByTestId('designer-stage').scrollIntoViewIfNeeded();
  const box = (await qrBox.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 150, { steps: 8 });
  await page.mouse.up();
  const moved = await qrValues(page);
  expect(moved.x).toBeLessThan(initial.x);
  expect(moved.y).toBeLessThan(initial.y);
  expect(moved.size).toBe(initial.size);

  // …resize it with the bottom-right handle…
  const handle = (await page.getByTestId('qr-handle-se').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40, handle.y + 40, { steps: 6 });
  await page.mouse.up();
  const resized = await qrValues(page);
  expect(resized.size).toBeGreaterThan(moved.size);
  expect(resized.x).toBe(moved.x); // top-left corner stays put

  // …and fine-tune X precisely in millimetres.
  await page.getByTestId('qr-x').fill('20.5');
  await page.getByTestId('qr-x').press('Enter');
  const final = { ...resized, x: 20.5 };
  await expect(page.getByTestId('qr-x')).toHaveValue('20.5');

  // 32: save → mydlo1 v1 with exactly these millimetre values.
  await page.getByRole('button', { name: 'Uložit šablonu (v1)' }).click();
  await expect(page.getByText('Uloženo jako mydlo1 v1.')).toBeVisible();
  // The detail preview uses the same API settings as the designer.
  const detailQr = page.getByTestId('version-preview-1').locator('svg');
  await expect(detailQr).toHaveAttribute('data-qr-value', (await designerQrValue(page)) ?? '');
  await expect(detailQr).toHaveAttribute('data-qr-level', 'Q');
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
  await expect(
    page.getByText(`X ${final.x} mm · Y ${final.y} mm · ${final.size} mm × ${final.size} mm`),
  ).toBeVisible();

  // 33: create 50 bottles using mydlo1 v1 (explicit confirmation required).
  await page.getByRole('link', { name: 'Vytvořit lahve s touto šablonou' }).click();
  await expect(page.getByLabel('Šablona etiket')).toContainText('mydlo1 v1');
  await page.getByRole('button', { name: '50', exact: true }).click();
  await page.getByRole('button', { name: 'Zkontrolovat' }).click();
  await expect(page.getByTestId('create-confirmation')).toHaveText(
    'Chystáte se vytvořit 50 lahví s trvalou identitou AYVO a šablonou etiket mydlo1 v1.',
  );
  // The review states the expected codes and this environment's QR URL (never production).
  await expect(page.getByTestId('expected-code-range')).toHaveText('AYV-B-000001 – AYV-B-000050');
  await expect(page.getByTestId('qr-url-pattern')).toHaveText('http://localhost:3100/q/<token>');
  await expect(
    page.getByText('každá etiketa nese označení „DEV - NOT FOR PRODUCTION“'),
  ).toBeVisible();
  const createButton = page.getByRole('button', { name: 'Vytvořit 50 lahví' });
  await expect(createButton).toBeDisabled();
  await page.getByLabel('Rozumím, že identity lahví jsou trvalé a nikdy se nemažou.').check();
  // The server registers the bottles, but the response is lost on the way back: the outcome is
  // unknown to the page, and pressing the button again must not create a second set of bottles.
  let attempts = 0;
  await page.route('**/api/admin/bottle-registrations', async (route) => {
    attempts++;
    if (attempts === 1) {
      firstRegistration = route.request().postDataJSON() as typeof firstRegistration;
      await route.fetch();
      await route.abort('connectionreset');
    } else {
      expect(route.request().postDataJSON()).toEqual(firstRegistration);
      await route.continue();
    }
  });
  await createButton.click();
  await expect(page.getByText('Opakované stisknutí tlačítka je bezpečné')).toBeVisible();
  await createButton.click();
  await page.unroute('**/api/admin/bottle-registrations');

  // 34: result with the code range and the series (creation batch) — the retry was a replay.
  await expect(page.getByRole('status')).toHaveText('50 lahví – úspěšně vytvořeno');
  await expect(page.getByText('žádné další lahve nebyly vytvořeny')).toBeVisible();
  await expect(page.getByTestId('result-batch-code')).toHaveText('BC-000001');
  await expect(page.getByTestId('result-code-range')).toHaveText('AYV-B-000001 – AYV-B-000050');

  // 35: generate labels.
  await page.getByRole('button', { name: 'Vygenerovat etikety' }).click();
  const download = page.getByRole('link', { name: /Stáhnout PDF/ });
  await expect(download).toBeVisible({ timeout: 60_000 });

  // 36: download the print-ready PDF: 50 pages of exactly 70 × 110 mm.
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toBe('PJ-000001_BC-000001_mydlo1-v1_50-labels.pdf');
  const pdf = await PDFDocument.load(await readFile((await file.path())!));
  expect(pdf.getPageCount()).toBe(50);
  for (const p of pdf.getPages()) {
    expect(p.getWidth() * MM_PER_PT).toBeCloseTo(70, 2);
    expect(p.getHeight() * MM_PER_PT).toBeCloseTo(110, 2);
  }

  // The series page shows the same creation and its completed print job.
  await page.getByRole('link', { name: 'Detail série' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BC-000001');
  await expect(page.getByText('AYV-B-000001 – AYV-B-000050')).toBeVisible();
  await expect(page.getByTestId('print-job-PJ-000001')).toContainText('Vygenerováno');
  // Not a production process: the job is flagged as DEV labels.
  await expect(page.getByTestId('print-job-PJ-000001')).toContainText(
    'DEV etikety – ne pro skutečné lahve',
  );

  // 37: open one bottle: CREATED timeline, QR and public URL.
  await page.getByRole('link', { name: 'Zobrazit lahve série' }).click();
  await expect(page.getByText('50 lahví odpovídá filtru')).toBeVisible();
  await page.getByRole('link', { name: 'AYV-B-000001' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AYV-B-000001');
  await expect(page.getByTestId('lifecycle')).toContainText('Identita vytvořena');
  await expect(page.getByTestId('reuse-cycles')).toHaveText('0');
  await expect(page.getByRole('img', { name: 'QR kód lahve AYV-B-000001' })).toBeVisible();
  const publicUrl = await page.getByTestId('public-url').textContent();
  expect(publicUrl).toMatch(/^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/);

  // The public passport behind that URL shows only public data.
  await page.goto(publicUrl!);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bottle AYV-B-000001');
  await expect(page.getByText('Registered reusable AYVO bottle')).toBeVisible();
  await expect(page.getByTestId('reuse-cycles')).toHaveText('0');
  await expect(page.locator('body')).not.toContainText(/BC-000001|mydlo1|CO2/);

  // Unknown tokens are not found.
  const missing = await page.goto('/q/AAAAAAAAAAAAAAAAAAAAAA');
  expect(missing?.status()).toBe(404);
});

test('Bottles live in Production: bottle list, creation history and series detail', async ({
  page,
}) => {
  // The global navigation lists company functions only — never Bottles or Label templates.
  await page.goto('/');
  const mainNav = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(mainNav.getByRole('link')).toHaveText(['Přehled', 'Sklad', 'Výroba']);

  // Výroba → Lahve: the bottle list is the default view.
  await mainNav.getByRole('link', { name: 'Výroba' }).click();
  await expect(page).toHaveURL(/\/production$/);
  const production = page.getByRole('navigation', { name: 'Výroba' });
  await production.getByRole('link', { name: 'Lahve' }).click();
  await expect(page).toHaveURL(/\/bottles$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lahve');
  await expect(production.getByRole('link', { name: 'Lahve' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(mainNav.getByRole('link', { name: 'Výroba' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const views = page.getByRole('navigation', { name: 'Zobrazení lahví' });
  await expect(views.getByRole('link', { name: 'Všechny lahve' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('50 lahví', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'AYV-B-000050' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Vytvořit lahve' })).toBeVisible();

  // Creation history inside Lahve: one creation, its labels and a download.
  await views.getByRole('link', { name: 'Historie vytvoření' }).click();
  await expect(page).toHaveURL(/\/bottles\/history$/);
  await expect(views.getByRole('link', { name: 'Historie vytvoření' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const series = page.getByTestId('series-BC-000001');
  await expect(page.getByTestId('creation-history').locator('tbody tr')).toHaveCount(1);
  await expect(series).toContainText('50');
  await expect(series).toContainText('AYV-B-000001 – AYV-B-000050');
  await expect(series).toContainText('mydlo1 v1');
  await expect(series).toContainText('Vygenerováno');
  await expect(series.getByRole('link', { name: 'Stáhnout PDF' })).toHaveAttribute(
    'href',
    '/api/admin/label-print-jobs/PJ-000001/pdf',
  );

  // Refresh keeps the view; the old list URL redirects here; the series detail still opens.
  await page.reload();
  await expect(page.getByTestId('series-BC-000001')).toBeVisible();
  await page.goto('/batches');
  await expect(page).toHaveURL(/\/bottles\/history$/);
  await page.goto('/batches/BC-000001');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BC-000001');
  await expect(page.getByText('Vytvořená série: 50 lahví')).toBeVisible();
  await expect(mainNav.getByRole('link', { name: 'Výroba' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: '← Lahve · Historie vytvoření' }).click();
  await expect(page).toHaveURL(/\/bottles\/history$/);

  // Bottle detail: status, reuse cycles, series as a secondary link, passport action.
  await page.goto('/bottles/AYV-B-000002');
  await expect(page.getByTestId('reuse-cycles')).toHaveText('0');
  await expect(page.getByRole('link', { name: 'BC-000001' })).toHaveAttribute(
    'href',
    '/batches/BC-000001',
  );
  await expect(page.getByRole('link', { name: 'Otevřít pas lahve' })).toHaveAttribute(
    'href',
    /^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/,
  );
  await expect(page.getByRole('navigation', { name: 'Umístění' })).toHaveText(
    /Výroba\s*\/\s*Lahve/,
  );

  // The production overview shows real figures: 50 bottles, all still waiting for their labels.
  await page.goto('/production');
  await expect(page.getByTestId('stat-bottles')).toHaveText('50');
  await expect(page.getByTestId('stat-awaiting-label')).toHaveText('50');
  await expect(page.getByTestId('stat-labeled')).toHaveText('0');
  await expect(page.getByTestId('recent-series')).toContainText('BC-000001');

  // Phone and tablet widths: no page-level horizontal scrolling on any Production page.
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/production',
      '/bottles',
      '/bottles/history',
      '/bottles/new',
      '/batches/BC-000001',
      '/bottles/AYV-B-000001',
    ]) {
      await page.goto(path);
      await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('a creation whose result was never shown is finished safely after a reload', async ({
  page,
}) => {
  // Simulates a reload while creating: the confirmed registration is still in sessionStorage.
  await page.goto('/bottles/new');
  await page.evaluate(
    (pending) => sessionStorage.setItem('ayvo.pendingBottleRegistration', JSON.stringify(pending)),
    firstRegistration,
  );
  await page.reload();
  await expect(page.getByTestId('unfinished-creation')).toContainText('50 lahví');
  await page.getByRole('button', { name: 'Dokončit a zobrazit výsledek' }).click();
  await expect(page.getByRole('status')).toHaveText('50 lahví – úspěšně vytvořeno');
  await expect(page.getByText('žádné další lahve nebyly vytvořeny')).toBeVisible();
  await expect(page.getByTestId('result-batch-code')).toHaveText('BC-000001');

  // Still exactly one creation and 50 bottles; the pending entry is gone.
  await page.goto('/bottles/history');
  await expect(page.getByTestId('creation-history').locator('tbody tr')).toHaveCount(1);
  await page.goto('/bottles');
  await expect(page.getByText('50 lahví', { exact: true })).toBeVisible();
  await page.goto('/bottles/new');
  await expect(page.getByTestId('unfinished-creation')).toHaveCount(0);
});

test('archived templates are no longer offered for new bottles', async ({ page }) => {
  // Archived templates stay viewable but are no longer offered for new bottles.
  await page.goto('/label-templates');
  await page.getByRole('link', { name: /mydlo1/ }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archivovat šablonu' }).click();
  await expect(page.getByText(/^Archivováno /)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Vytvořit lahve s touto šablonou' })).toHaveCount(0);
  await page.goto('/bottles/new');
  await expect(page.getByText('Nejprve vytvořte šablonu etiket')).toBeVisible();
  await expect(page.getByLabel('Šablona etiket')).toHaveCount(0);
});

/** The designer preview value captured before saving (same settings → same preview URL). */
async function designerQrValue(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const res = new XMLHttpRequest();
    res.open('GET', '/api/admin/label-designer/settings', false);
    res.send();
    return (JSON.parse(res.responseText) as { qrPreviewUrl: string }).qrPreviewUrl;
  });
}
