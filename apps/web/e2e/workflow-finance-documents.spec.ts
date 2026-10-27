import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance — received documents (doc 039, N1) in the browser: receive the original, see it in the
 * list, download it unchanged, correct its metadata with a reason (history), void it; a user
 * without Finance sees no module and is refused. Synthetic supplier and documents only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Přijaté doklady', () => {
  test.use({ storageState: ADMIN_STATE });

  test('receive, list, download, correct with history and void a document', async ({ page }) => {
    const supplier = `Pronajímatel ${randomUUID().slice(0, 6)}`;
    const created = await page.request.post('/api/admin/suppliers', {
      data: { requestId: randomUUID(), name: supplier, companyId: null, vatId: null },
    });
    expect(created.status()).toBe(201);
    const number = `NAJ-${randomUUID().slice(0, 6)}`;
    const original = Buffer.from(`%PDF-1.4\n% synteticky najem ${number}\n%%EOF\n`);

    await page.goto('/finance/documents');
    await expect(page.getByRole('heading', { level: 1, name: 'Přijaté doklady' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Hlavní navigace' })
        .getByRole('link', { name: 'Finance' }),
    ).toBeVisible();
    // The list is the default screen; receiving is its main action (UI-02).
    await expect(page.getByTestId('receive-document')).toHaveCount(0);
    await page.getByTestId('finance-upload').click();
    await expect(page).toHaveURL(/\/finance\/documents\/new$/);
    const form = page.getByTestId('receive-document');
    await form.getByLabel('Originál (PDF)').setInputFiles({
      name: 'Najem rijen.pdf',
      mimeType: 'application/pdf',
      buffer: original,
    });
    await form.getByLabel('Dodavatel').selectOption({ label: supplier });
    await form.getByLabel('Číslo dokladu').fill(number);
    await form.getByLabel('Datum vystavení').fill('2026-10-01');
    await form.getByLabel('DUZP').fill('2026-10-01');
    await form.getByLabel('Splatnost').fill('2026-10-15');
    await form.getByLabel('Částka celkem').fill('25000.00');
    await form.getByLabel('Předávací měsíc').fill('2026-10');
    await form.getByLabel('Popis').fill('Nájem skladu – říjen (syntetický)');
    await form.getByRole('button', { name: 'Přijmout doklad' }).click();

    await expect(page).toHaveURL(/\/finance\/documents\/FD-\d{6}$/);
    const code = page.url().split('/').pop()!;
    const detail = page.getByTestId('finance-document');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${code} · Faktura ${number}`);
    await expect(detail).toContainText(supplier);
    await expect(detail).toContainText('25 000,00 CZK');
    await expect(detail).toContainText('15. 10. 2026');
    await expect(detail).toContainText('10/2026');
    await expect(detail).toContainText('Nahráno ve Financích');
    await expect(page.getByTestId('finance-history')).toContainText('Přijat');

    // The original, byte for byte, as a download.
    const download = page.waitForEvent('download');
    await page.getByTestId('finance-download').click();
    const file = await (await download).path();
    expect(Buffer.compare(await readFile(file!), original)).toBe(0);
    expect((await download).suggestedFilename()).toBe(`${code}-Najem rijen.pdf`);

    // In the list and found by its number.
    await page.goto(`/finance/documents?q=${number}`);
    const list = page.getByTestId('finance-documents');
    await expect(list.getByRole('link', { name: code })).toBeVisible();
    await expect(list).toContainText('1 doklad');

    // Correct the amount with a reason: a new version, the change in the history.
    await page.goto(`/finance/documents/${code}`);
    await page.getByRole('button', { name: 'Opravit údaje' }).click();
    const correct = page.getByTestId('finance-correct');
    await correct.getByLabel('Částka celkem').fill('30250.00');
    await correct.getByLabel('Důvod (povinný)').fill('Částka včetně DPH');
    await correct.getByRole('button', { name: 'Uložit opravu' }).click();
    await expect(detail).toContainText('30 250,00 CZK');
    const history = page.getByTestId('finance-history');
    await expect(history).toContainText('Opraven');
    await expect(history).toContainText('Částka včetně DPH');
    await expect(history).toContainText(
      'Částka celkem: 25\u00a0000,00\u00a0CZK → 30\u00a0250,00\u00a0CZK',
    );

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: resolve(screenshots, `finance-document-${width}.png`),
        fullPage: true,
      });
    }
    await page.goto('/finance/documents');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: resolve(screenshots, `finance-documents-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Void with a reason: it stays, read-only, still downloadable.
    await page.goto(`/finance/documents/${code}`);
    await page.getByRole('button', { name: 'Zrušit doklad' }).click();
    const voidForm = page.getByTestId('finance-void');
    await voidForm.getByLabel('Důvod (povinný)').fill('Nahráno omylem (test)');
    await voidForm.getByRole('button', { name: 'Zrušit doklad' }).click();
    await expect(page.getByText('Doklad je zrušený')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Opravit údaje' })).toHaveCount(0);
    await expect(history).toContainText('Zrušen');
    await expect(page.getByTestId('finance-download')).toBeVisible();
  });
});

test.describe('Rozpracovaný doklad a převzetí ze skladu', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a draft is "K doplnění" until completed; a supplier document is taken over without a copy', async ({
    page,
  }) => {
    // A draft: only the original and the kind.
    await page.goto('/finance/documents/new');
    const form = page.getByTestId('receive-document');
    await form.getByLabel('Originál (PDF)').setInputFiles({
      name: 'uctenka.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(`%PDF-1.4\n% koncept ${randomUUID()}\n%%EOF\n`),
    });
    await form.getByRole('button', { name: 'Přijmout doklad' }).click();
    await expect(page).toHaveURL(/\/finance\/documents\/FD-\d{6}$/);
    const draft = page.url().split('/').pop()!;
    await expect(
      page.getByText('Pro export pro účetní chybí: dodavatel, číslo dokladu'),
    ).toBeVisible();
    await page.goto('/finance/documents?incomplete=true');
    const list = page.getByTestId('finance-documents');
    await expect(list.getByRole('link', { name: draft })).toBeVisible();
    await expect(list.getByTestId('finance-missing').first()).toBeVisible();

    // A supplier document of Sklad, taken over into Finance.
    const supplier = `Dodavatel skladu ${randomUUID().slice(0, 6)}`;
    const created = await page.request.post('/api/admin/suppliers', {
      data: { requestId: randomUUID(), name: supplier, companyId: null, vatId: null },
    });
    expect(created.status()).toBe(201);
    const number = `SKL-${randomUUID().slice(0, 6)}`;
    const original = Buffer.from(`%PDF-1.4\n% sklad ${number}\n%%EOF\n`);
    const uploaded = await page.request.post('/api/admin/supplier-documents', {
      multipart: {
        requestId: randomUUID(),
        supplierId: (await created.json()).id,
        kind: 'INVOICE',
        documentNumber: number,
        issuedOn: '2026-10-07',
        file: { name: 'sklad.pdf', mimeType: 'application/pdf', buffer: original },
      },
    });
    expect(uploaded.status()).toBe(201);
    await page.goto('/finance/documents');
    await page.getByTestId('finance-take-over-link').click();
    await expect(page).toHaveURL(/\/finance\/documents\/take-over$/);
    const takeOver = page.getByTestId('finance-take-over');
    await takeOver.getByLabel('Předávací měsíc').fill('2026-10');
    const row = takeOver.getByRole('listitem').filter({ hasText: number });
    await row.getByRole('button', { name: 'Převzít' }).click();
    await expect(page).toHaveURL(/\/finance\/documents\/FD-\d{6}$/);
    const detail = page.getByTestId('finance-document');
    await expect(detail).toContainText('Doklad ze skladu');
    await expect(detail).toContainText(supplier);
    await expect(detail).toContainText('10/2026');
    const download = page.waitForEvent('download');
    await page.getByTestId('finance-download').click();
    expect(Buffer.compare(await readFile((await (await download).path())!), original)).toBe(0);
    await page.goto('/finance/documents/take-over');
    await expect(
      page.getByTestId('finance-take-over').getByRole('listitem').filter({ hasText: number }),
    ).toContainText('Převzato jako FD-');
  });
});

test.describe('without Finance permissions', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the module is not offered and its pages and API are refused', async ({ page }) => {
    await page.goto('/');
    await expect(
      page
        .getByRole('navigation', { name: 'Hlavní navigace' })
        .getByRole('link', { name: 'Finance' }),
    ).toHaveCount(0);
    await page.goto('/finance/documents');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await page.request.get('/api/admin/finance/documents')).status()).toBe(403);
    for (const path of ['/finance/documents/new', '/finance/documents/take-over']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/forbidden$/);
    }
  });
});
