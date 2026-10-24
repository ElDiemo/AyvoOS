import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Finance — export for the accountant (doc 039 §7, N2) in the browser: preview, create, download
 * the ZIP (read by Python's zipfile, CRC checked), then a later correction shows on the export as
 * "changed after the export". Synthetic data in its own period (2011-03).
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');
test.use({ storageState: 'e2e/.auth/admin.json' });

test('preview, create and download an export; later changes are shown on it', async ({ page }) => {
  const supplier = await page.request.post('/api/admin/suppliers', {
    data: {
      requestId: randomUUID(),
      name: `Účetní kancelář ${randomUUID().slice(0, 6)}`,
      companyId: null,
      vatId: null,
    },
  });
  expect(supplier.status()).toBe(201);
  const supplierId = ((await supplier.json()) as { id: string }).id;
  const codes: string[] = [];
  for (const [day, amount] of [
    ['2011-03-05', '4500.00'],
    ['2011-03-28', '1200.50'],
  ] as const) {
    const res = await page.request.post('/api/admin/finance/documents', {
      multipart: {
        requestId: randomUUID(),
        supplierId,
        kind: 'INVOICE',
        documentNumber: `UC-${randomUUID().slice(0, 6)}`,
        issuedOn: day,
        totalAmount: amount,
        currency: 'CZK',
        file: {
          name: 'faktura.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`),
        },
      },
    });
    expect(res.status()).toBe(201);
    codes.push(((await res.json()) as { code: string }).code);
  }

  await page.goto('/finance/exports');
  await expect(page.getByRole('heading', { level: 1, name: 'Export pro účetní' })).toBeVisible();
  const form = page.getByTestId('create-export');
  await form.getByLabel('Období od').fill('2011-03-01');
  await form.getByLabel('Období do').fill('2011-03-31');
  await form.getByLabel('Druh exportu').selectOption('FULL');
  await form.getByLabel('Poznámka (nepovinná)').fill('Březen 2011 (test)');
  await form.getByRole('button', { name: 'Zobrazit náhled' }).click();
  const preview = page.getByTestId('export-preview');
  await expect(preview).toContainText('2 doklady');
  for (const code of codes) await expect(preview).toContainText(code);
  await preview.getByRole('button', { name: 'Vytvořit export' }).click();

  await expect(page).toHaveURL(/\/finance\/exports\/AE-\d{6}$/);
  await expect(page.getByTestId('export-later')).toContainText('nic nezměnilo');
  await expect(page.getByTestId('export-lines')).toContainText('4 500,00 CZK');

  const download = page.waitForEvent('download');
  await page.getByTestId('export-download').click();
  const zipPath = await (await download).path();
  const listed = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))',
      zipPath!,
    ],
    { encoding: 'utf8' },
  );
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout.trim().split('\n')).toEqual([
    'manifest.csv',
    'README.txt',
    `doklady/${codes[0]}-faktura.pdf`,
    `doklady/${codes[1]}-faktura.pdf`,
  ]);

  // A later correction appears on the export as "changed after the export".
  const exportUrl = page.url();
  const doc = (await (
    await page.request.get(`/api/admin/finance/documents/${codes[1]}`)
  ).json()) as {
    documentNumber: string;
    version: number;
  };
  const corrected = await page.request.post(`/api/admin/finance/documents/${codes[1]}/correct`, {
    data: {
      supplierId,
      kind: 'INVOICE',
      documentNumber: doc.documentNumber,
      issuedOn: '2011-03-28',
      totalAmount: '1452.61',
      currency: 'CZK',
      expectedVersion: doc.version,
      reason: 'Oprava částky (test)',
    },
  });
  expect(corrected.status()).toBe(200);
  await page.goto(exportUrl);
  const later = page.getByTestId('export-later');
  await expect(later).toContainText(codes[1]!);
  await expect(later).toContainText('změněné údaje');

  await mkdir(screenshots, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: resolve(screenshots, `finance-export-${width}.png`),
      fullPage: true,
    });
  }
});
