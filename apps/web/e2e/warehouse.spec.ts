import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Milestone 2A warehouse flow in Czech (doc 018): supplier → goods receipt with a delivery note
 * (internal lot) → session lot → physical label application by scanning (Enter), duplicate,
 * wrong environment, not an AYVO label, lot exhausted → invoice linked later → stock, ledger and
 * the bottle's physical facts. Self-contained: creates its own printed bottles.
 */
test.describe.configure({ mode: 'serial' });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let urls: string[] = [];
let codes: string[] = [];
let receiptCode = '';
let lotCode = '';

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      {
        message: `horizontal overflow on ${what}`,
      },
    )
    .toBeLessThanOrEqual(0);
}

test.beforeAll(async ({ request }) => {
  const artwork = await json<{ id: string }>(
    await request.post('/api/admin/label-artworks', {
      multipart: {
        file: {
          name: 'mydlo1.svg',
          mimeType: 'image/svg+xml',
          buffer: await readFile(resolve(import.meta.dirname, 'fixtures/mydlo1.svg')),
        },
      },
    }),
  );
  const version = await json<{ versionId: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name: `sklad-${Date.now()}`,
        layout: {
          artworkId: artwork.id,
          widthMm: 70,
          heightMm: 110,
          elements: [
            { type: 'QR_CODE', xMm: 27.5, yMm: 70, widthMm: 15, heightMm: 15, rotationDeg: 0 },
          ],
        },
      },
    }),
  );
  const registration = await json<{
    batch: { firstBottleCode: string; lastBottleCode: string };
    printJob: { code: string };
  }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: 3,
      },
    }),
  );
  await json(
    await request.post(`/api/admin/label-print-jobs/${registration.printJob.code}/generate`),
  );
  const first = Number(registration.batch.firstBottleCode.slice(6));
  codes = [0, 1, 2].map((i) => `AYV-B-${String(first + i).padStart(6, '0')}`);
  urls = [];
  for (const code of codes) {
    urls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
});

test('receive new bottles: supplier, delivery note, internal lot, invoice pending', async ({
  page,
}) => {
  await page.goto('/warehouse');
  await expect(page).toHaveURL(/\/warehouse\/labels$/);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sklad' }),
  ).toHaveAttribute('aria-current', 'page');

  await page
    .getByRole('navigation', { name: 'Sklad' })
    .getByRole('link', { name: 'Dodavatelé' })
    .click();
  await page.getByLabel('Název').fill('Lahve Test s.r.o.');
  await page.getByRole('button', { name: 'Založit dodavatele' }).click();
  await expect(page.getByTestId('suppliers')).toContainText('Lahve Test s.r.o.');

  await page
    .getByRole('navigation', { name: 'Sklad' })
    .getByRole('link', { name: 'Příjem zboží' })
    .click();
  await page
    .getByRole('combobox', { name: 'Dodavatel' })
    .selectOption({ label: 'Lahve Test s.r.o.' });
  await page.getByLabel('Dodací list / faktura č.').fill('DL-2026-001');
  await page.getByLabel('Číslo dokladu').fill('DL-2026-001');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'dodaci-list.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Nahrát doklad' }).click();
  await expect(page.getByTestId('receipt-documents')).toContainText('Dodací list DL-2026-001');
  await page
    .getByTestId('receipt-line-1')
    .getByLabel(/Množství/)
    .fill('2');
  await page.getByRole('button', { name: 'Zkontrolovat' }).click();
  await expect(page.getByTestId('receipt-review')).toContainText('Čeká na fakturu');
  await page.getByRole('button', { name: 'Potvrdit příjem' }).click();

  await expect(page).toHaveURL(/\/warehouse\/receipts\/GR-\d{6}\?created=1$/);
  receiptCode = page.url().match(/GR-\d{6}/)![0];
  lotCode = `${receiptCode}/1`;
  await expect(page.getByRole('status')).toContainText(`Příjem ${receiptCode} byl potvrzen`);
  await expect(page.getByTestId('invoice-status')).toHaveText('Čeká na fakturu');
  await expect(page.getByTestId('line-1')).toContainText(lotCode);
});

test('apply labels by scanning: session lot, applied, duplicate, rejections, lot exhausted', async ({
  page,
}) => {
  await page.goto('/warehouse/labels');
  await page
    .getByTestId('lot-choices')
    .getByRole('button', { name: new RegExp(lotCode) })
    .click();
  await expect(page.getByTestId('active-lot')).toContainText(lotCode);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 2 ks');

  // The session lot survives a refresh; the scan field has focus; Enter submits.
  await page.reload();
  await expect(page.getByTestId('active-lot')).toContainText(lotCode);
  const scan = page.getByTestId('scan-input');
  await expect(scan).toBeFocused();
  await scan.fill(urls[0]!);
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText(`${codes[0]} – etiketa nalepena`);
  await expect(page.getByTestId('scan-outcome')).toContainText(`ze šarže ${lotCode}. Zbývá 1 ks.`);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 1 ks');
  await expect(scan).toHaveValue('');
  await expect(scan).toBeFocused();

  await scan.fill(urls[0]!);
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText('etiketa už byla nalepena');
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 1 ks');

  await scan.fill(`https://qr.ayvo.co/${urls[1]!.split('/').pop()}`);
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText('Etiketa patří do jiného prostředí');
  await scan.fill('AYV-B-000001');
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText('Toto není etiketa AYVO');

  await scan.fill(urls[1]!);
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText(`${codes[1]} – etiketa nalepena`);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 0 ks');
  await expect(page.getByText('Šarže je vyčerpaná', { exact: true })).toBeVisible();
  await expect(page.getByTestId('scan-input')).toHaveCount(0); // scanning stops; no silent switch
  await expect(page.getByTestId('session-results').locator('li')).toHaveCount(5);
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co/'); // never echoed back

  await page.getByRole('button', { name: 'Změnit šarži' }).click();
  await expect(page.getByTestId('no-lots')).toBeVisible();
});

test('invoice linked later, stock and ledger, bottle physical facts, phone width', async ({
  page,
}) => {
  await page.goto(`/warehouse/receipts/${receiptCode}`);
  await page.getByRole('combobox', { name: 'Druh dokladu' }).selectOption('INVOICE');
  await page.getByLabel('Číslo dokladu').fill('FV-2026-001');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'faktura.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Přiložit' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Faktura doložena');
  await expect(page.getByTestId('documents')).toContainText('Faktura');

  await page.goto('/warehouse/movements');
  const ledger = page.getByTestId('movements');
  await expect(ledger).toContainText('Nalepení etikety');
  await expect(ledger).toContainText(codes[1]!);
  await expect(ledger).toContainText(receiptCode);

  await page.goto('/warehouse/stock');
  await expect(page.getByTestId('stock-NEW_BOTTLE')).toContainText('Nová prázdná lahev');

  await page.goto(`/bottles/${codes[0]}`);
  await expect(page.getByText('LABELED_EMPTY')).toBeVisible();
  await expect(page.getByTestId('physical')).toContainText(lotCode);
  await expect(page.getByTestId('physical')).toContainText(receiptCode);
  await expect(page.getByTestId('components')).toContainText('LABEL');
  await page.goto(`/bottles/${codes[2]}`);
  await expect(page.getByTestId('physical')).toContainText('not been applied');

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/warehouse/labels',
      '/warehouse/receipts/new',
      '/warehouse/receipts',
      `/warehouse/receipts/${receiptCode}`,
      '/warehouse/stock',
      '/warehouse/suppliers',
    ]) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
  }
});
