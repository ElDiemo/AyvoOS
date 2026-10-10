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

async function qrValues(page: Page) {
  const read = async (id: string) => Number(await page.getByTestId(id).inputValue());
  return { x: await read('qr-x'), y: await read('qr-y'), size: await read('qr-width') };
}

test('create template, register 50 bottles, print labels, inspect a bottle', async ({ page }) => {
  // 29–30: create template "mydlo1" and upload artwork.
  await page.goto('/label-templates');
  await page.getByRole('link', { name: 'Create template' }).click();
  await page.getByLabel('Template name').fill('mydlo1');
  await page
    .getByLabel('Background artwork (SVG, PNG or JPEG)')
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
  await page.getByRole('button', { name: 'Save template (v1)' }).click();
  await expect(page.getByText('Saved as mydlo1 v1.')).toBeVisible();
  // The detail preview uses the same API settings as the designer.
  const detailQr = page.getByTestId('version-preview-1').locator('svg');
  await expect(detailQr).toHaveAttribute('data-qr-value', (await designerQrValue(page)) ?? '');
  await expect(detailQr).toHaveAttribute('data-qr-level', 'Q');
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
  await expect(
    page.getByText(`X ${final.x} mm · Y ${final.y} mm · ${final.size} mm × ${final.size} mm`),
  ).toBeVisible();

  // 33: create 50 bottles using mydlo1 v1 (explicit confirmation required).
  await page.getByRole('link', { name: 'Create bottles with mydlo1 v1' }).click();
  await expect(page.getByLabel('Label template')).toContainText('mydlo1 v1');
  await page.getByRole('button', { name: '50', exact: true }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByTestId('create-confirmation')).toHaveText(
    'You are about to create 50 permanent AYVO bottle identities using label template mydlo1 v1.',
  );
  const createButton = page.getByRole('button', { name: 'Create 50 bottles' });
  await expect(createButton).toBeDisabled();
  await page
    .getByLabel('I understand that bottle identities are permanent and are never deleted.')
    .check();
  await createButton.click();

  // 34: result with the creation batch and the code range.
  await expect(page.getByRole('status')).toHaveText('50 bottles created successfully');
  await expect(page.getByTestId('result-batch-code')).toHaveText('BC-000001');
  await expect(page.getByText('AYV-B-000001 – AYV-B-000050')).toBeVisible();

  // 35: generate labels.
  await page.getByRole('button', { name: 'Generate labels' }).click();
  const download = page.getByRole('link', { name: /Download PDF/ });
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

  // The batch page shows the same batch and its completed print job.
  await page.getByRole('link', { name: 'View batch' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BC-000001');
  await expect(page.getByText('AYV-B-000001 – AYV-B-000050')).toBeVisible();
  await expect(page.getByTestId('print-job-PJ-000001')).toContainText('COMPLETED');
  // Not a production process: the job is flagged as DEV labels.
  await expect(page.getByTestId('print-job-PJ-000001')).toContainText(
    'DEV labels - not for real bottles',
  );

  // 37: open one bottle: CREATED timeline, QR and public URL.
  await page.getByRole('link', { name: 'View bottles' }).click();
  await expect(page.getByText('50 bottles matching the filters')).toBeVisible();
  await page.getByRole('link', { name: 'AYV-B-000001' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AYV-B-000001');
  await expect(page.getByTestId('lifecycle')).toContainText('CREATED');
  await expect(page.getByRole('img', { name: 'QR code of AYV-B-000001' })).toBeVisible();
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

  // Archived templates stay viewable but are no longer offered for new bottles.
  await page.goto('/label-templates');
  await page.getByRole('link', { name: /mydlo1/ }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archive template' }).click();
  await expect(page.getByText(/^Archived /)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create bottles with mydlo1 v1' })).toHaveCount(0);
  await page.goto('/bottles/new');
  await expect(page.getByText('Create a label template')).toBeVisible();
  await expect(page.getByLabel('Label template')).toHaveCount(0);
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
