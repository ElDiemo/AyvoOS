import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * Návrhy smluv (ADR 0043, doc 045) in the browser, synthetic data, standalone: a prospect →
 * "Připravit návrh smlouvy" (nothing written by opening it) → the wizard with the holder rule →
 * saved → the printable PDF → edited (a new revision) → linked to an existing hotel by hand →
 * opened from the hotel's card → removed with confirmation and restored → the already signed PDF
 * uploaded and locked, a later change an amendment. Another salesperson never sees it. Desktop and
 * phone.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/contracts');

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
async function shot(page: Page, name: string, widths: number[] = [1440, 390]) {
  await mkdir(screenshots, { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      `${name} at ${width}`,
    ).toBeLessThanOrEqual(0);
    await page.screenshot({ path: resolve(screenshots, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.serial('Návrhy smluv', () => {
  test.use({ storageState: ADMIN_STATE });
  const run = crypto.randomUUID().slice(0, 6).toUpperCase();
  let prospect = '';
  let hotel = '';
  let draft = '';

  test('prepare → save → PDF → edit → link a hotel → open from the hotel → remove and restore', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const r = page.request;
    prospect = (
      await json<{ code: string }>(
        await r.post('/api/admin/sales/prospects', {
          data: {
            requestId: crypto.randomUUID(),
            name: `Hotel Akvizice ${run}`,
            countryCode: 'CZ',
            city: 'Brno',
            addressLine1: 'Akviziční 3',
            addressLine2: null,
            postalCode: '602 00',
            roomsEstimate: 48,
            accommodationType: 'HOTEL',
            website: null,
            source: null,
            priority: null,
            note: null,
            ownerId: null,
            contact: null,
            acknowledgeDuplicates: true,
          },
        }),
      )
    ).code;
    hotel = (
      await json<{ code: string }>(
        await r.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name: `Hotel Smlouva ${run}`,
            addressLine1: 'Hotelová 9',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 047',
            contactEmail: 'recepce@navrh.test',
            fulfillmentSiteId: INITIAL_SITE_ID,
          },
        }),
      )
    ).code;
    const drafts = async (q: string) =>
      json<{ code: string }[]>(await r.get(`/api/admin/contracts/drafts?${q}`));

    // The prospect: no draft; the explicit way to prepare one.
    await page.goto(`/sales/prospects/${prospect}`);
    const card = page.getByTestId('contract-drafts');
    await expect(card).toContainText('Zatím žádný návrh smlouvy');
    await card.getByTestId('contract-prepare').click();
    await expect(page).toHaveURL(new RegExp(`/sales/contracts/new\\?prospect=${prospect}$`));
    const w = page.getByTestId('contract-wizard');
    // Prefilled from the prospect; nothing written by opening the wizard.
    await expect(w.locator('[name=hotelName]')).toHaveValue(`Hotel Akvizice ${run}`);
    await expect(w.locator('[name=hotelAddress]')).toHaveValue('Akviziční 3, 602 00 Brno');
    await expect(w.locator('[name=rooms]')).toHaveValue('48');
    await expect(page.getByText('NÁVRH – K PRÁVNÍ KONTROLE').first()).toBeVisible();
    expect(await drafts(`prospect=${prospect}`)).toEqual([]);
    await expect(w.getByTestId('contract-save')).toBeDisabled();
    await expect(w.getByTestId('contract-missing')).toContainText('Právní název');

    await w.locator('[name=counterpartyName]').fill(`Hotelová společnost ${run} s.r.o.`);
    await w.locator('[name=counterpartyCompanyId]').fill('12345678');
    await w.locator('[name=counterpartyAddress]').fill('Ukázková 1, 602 00 Brno');
    await w.locator('[name=representativeName]').fill('Jana Ukázková');
    await w.locator('[name=representativeRole]').fill('jednatelka');
    await w.locator('[name=price]').fill('1 200,50');
    await w.locator('[name=startOn]').fill('2027-01-01');
    await w.locator('[name=billingTiming]').selectOption('ARREARS');
    await w.locator('[name=paymentTermsDays]').fill('14');
    // Holders: the ownership exists only "S držáky"; "Bez držáků" hides and clears it.
    const ownership = w.locator('[name=holdersOwnership]');
    await expect(ownership).toHaveCount(0);
    await w.locator('[name=holders]').selectOption('WITH');
    await ownership.selectOption('CUSTOMER');
    await w.locator('[name=holders]').selectOption('NONE');
    await expect(ownership).toHaveCount(0);
    await w.locator('[name=holders]').selectOption('WITH');
    await expect(ownership).toHaveValue('');
    await expect(w.getByTestId('contract-missing')).toContainText('Vlastnictví držáků');
    await ownership.selectOption('AYVO');
    await expect(w.getByTestId('contract-check')).toContainText(
      'S držáky · Zůstávají ve vlastnictví AYVO',
    );
    await expect(w.getByTestId('contract-save')).toBeDisabled();
    await w.getByTestId('contract-checked').check();
    await shot(page, 'contract-wizard');
    await w.getByTestId('contract-save').click();

    // Saved at the prospect; its page.
    await expect(page).toHaveURL(/\/sales\/contracts\/SN-\d{6}\?saved=1$/);
    draft = /SN-\d{6}/.exec(page.url())![0];
    await expect(page.getByTestId('contract-holders')).toHaveText(
      'S držáky · Zůstávají ve vlastnictví AYVO',
    );
    await expect(page.getByTestId('contract-price')).toHaveText('1\u00a0200,50 CZK');
    await expect(page.getByTestId('contract-hotel')).toHaveText('Nepřipojený k hotelu');

    // The printable PDF of the saved revision.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('contract-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${draft}-r1-NAVRH.pdf`);
    const bytes = await (
      await r.get(`/api/admin/contracts/drafts/${draft}/revisions/1/pdf`)
    ).body();
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');

    // Edit: a new revision with a reason; the first one stays.
    await page.getByTestId('contract-edit-open').click();
    const edit = page.getByTestId('contract-edit').getByTestId('contract-wizard');
    await expect(edit.locator('[name=holdersOwnership]')).toHaveValue('AYVO');
    await edit.locator('[name=rooms]').fill('50');
    await edit.locator('[name=holders]').selectOption('NONE');
    await edit.locator('[name=reason]').fill('Upřesnění po jednání (test)');
    await edit.getByTestId('contract-checked').check();
    await edit.getByTestId('contract-save').click();
    await expect(page.getByTestId('contract-current')).toContainText('Aktuální revize 2');
    await expect(page.getByTestId('contract-holders')).toHaveText('Bez držáků');
    await expect(page.getByTestId('contract-revisions').locator('li')).toHaveCount(2);

    // Linked by hand to a hotel that is NOT the one the draft names: both identities shown, the
    // link only after an explicit acknowledgement; the page then says so (review CD121-1).
    const link = page.getByTestId('contract-link-hotel');
    await link.locator('[name=hotelCode]').selectOption(hotel);
    await link.locator('[name=reason]').fill('Akvizice je hotel (test)');
    const mismatch = link.getByTestId('hotel-mismatch');
    await expect(mismatch).toContainText(`Hotel Akvizice ${run}, Akviziční 3, 602 00 Brno`);
    await expect(mismatch).toContainText(`Hotel Smlouva ${run}, Hotelová 9, 602 00 Brno`);
    await expect(link.getByTestId('contract-link-submit')).toBeDisabled();
    await shot(page, 'contract-link-mismatch', [1440]);
    await mismatch.getByTestId('hotel-mismatch-ack').check();
    await link.getByTestId('contract-link-submit').click();
    await expect(page.getByTestId('contract-hotel')).toHaveText(`Hotel Smlouva ${run}`);
    await expect(page.getByTestId('contract-hotel-mismatch')).toBeVisible();

    // The wrong link corrected (audited) to the hotel the draft really names: no mismatch left.
    const named = (
      await json<{ code: string }>(
        await r.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name: `Hotel Akvizice ${run}`,
            addressLine1: 'Akviziční 3',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 048',
            contactEmail: 'recepce@navrh.test',
            fulfillmentSiteId: INITIAL_SITE_ID,
          },
        }),
      )
    ).code;
    await page.reload();
    const correct = page.getByTestId('contract-link');
    await expect(correct.getByRole('heading')).toHaveText('Opravit vazbu na hotel');
    await correct.locator('[name=hotelCode]').selectOption(named);
    await expect(correct.getByTestId('hotel-mismatch')).toHaveCount(0);
    await correct.locator('[name=reason]').fill('Oprava chybné vazby (test)');
    await correct.getByTestId('contract-link-submit').click();
    await expect(page.getByTestId('contract-hotel')).toHaveText(`Hotel Akvizice ${run}`);
    await expect(page.getByTestId('contract-hotel-mismatch')).toHaveCount(0);
    hotel = named;
    await shot(page, 'contract-detail');

    // Opened from the hotel's card.
    await page.goto(`/hotels/${hotel}`);
    const onHotel = page.getByTestId('contract-drafts');
    await expect(onHotel.getByTestId('contract-draft-list')).toContainText(draft);
    await shot(page, 'contract-hotel', [1440]);
    await onHotel.getByRole('link', { name: draft }).click();
    await expect(page).toHaveURL(new RegExp(`/sales/contracts/${draft}$`));

    // Removed with confirmation and a reason; restorable; nothing deleted.
    await page.getByTestId('contract-removal-open').click();
    const remove = page.getByTestId('contract-remove');
    await remove.locator('[name=reason]').fill('Zadáno omylem (test)');
    await expect(remove.getByTestId('contract-confirm-submit')).toBeDisabled();
    await remove.getByTestId('contract-confirm').check();
    await remove.getByTestId('contract-confirm-submit').click();
    await expect(page.getByTestId('contract-removed')).toContainText('Zadáno omylem (test)');
    await expect(page.getByTestId('contract-edit')).toHaveCount(0);
    await page.getByTestId('contract-removal-open').click();
    const restore = page.getByTestId('contract-restore');
    await restore.locator('[name=reason]').fill('Přece platí (test)');
    await restore.getByTestId('contract-confirm').check();
    await restore.getByTestId('contract-confirm-submit').click();
    await expect(page.getByTestId('contract-removed')).toHaveCount(0);
    await expect(page.getByTestId('contract-events')).toContainText('obnoven');
  });

  test('the already signed PDF: uploaded with confirmation, kept, downloadable; the draft locked; a change is an amendment', async ({
    page,
  }) => {
    await page.goto(`/sales/contracts/${draft}`);
    const card = page.getByTestId('contract-signed');
    await expect(card).toContainText('Zatím žádný podepsaný originál');
    await card.getByTestId('contract-upload-open').click();
    const form = card.getByTestId('contract-upload-signed');
    // A real PDF (the printed revision itself stands in for the signed scan).
    const signed = await (
      await page.request.get(`/api/admin/contracts/drafts/${draft}/revisions/2/pdf`)
    ).body();
    await form.locator('[name=file]').setInputFiles({
      name: 'smlouva-podepsana.pdf',
      mimeType: 'application/pdf',
      buffer: signed,
    });
    await form.locator('[name=signedOn]').fill('2026-11-02');
    await expect(form.getByTestId('contract-upload-submit')).toBeDisabled();
    await form.getByTestId('contract-upload-confirm').check();
    await form.getByTestId('contract-upload-submit').click();
    await expect(card.getByTestId('contract-signed-list')).toContainText(
      'revize 2 · podepsáno 2. 11. 2026',
    );
    // Downloaded exactly as uploaded.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      card.getByTestId('contract-signed-download-2').click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${draft}-r2-PODEPSANO.pdf`);
    const bytes = await (
      await page.request.get(`/api/admin/contracts/drafts/${draft}/signed/2`)
    ).body();
    expect(Buffer.compare(bytes, signed)).toBe(0);
    // Locked: no removal, no hotel correction, no second upload of this revision.
    await expect(page.getByTestId('contract-removal-locked')).toBeVisible();
    await expect(page.getByTestId('contract-removal')).toHaveCount(0);
    await expect(page.getByTestId('contract-link')).toHaveCount(0);
    await expect(card.getByTestId('contract-upload-open')).toHaveCount(0);
    await shot(page, 'contract-signed');
    // A change after signing: a new revision (an amendment proposal); the signed one stays.
    await page.getByTestId('contract-edit-open').click();
    const edit = page.getByTestId('contract-edit');
    await expect(edit).toContainText('Revize je podepsaná');
    await edit.locator('[name=rooms]').fill('55');
    await edit.locator('[name=reason]').fill('Dodatek po podpisu (test)');
    await edit.getByTestId('contract-checked').check();
    await edit.getByTestId('contract-save').click();
    await expect(page.getByTestId('contract-current')).toContainText('Aktuální revize 3');
    await expect(card.getByTestId('contract-signed-list')).toContainText('revize 2');
    await expect(card.getByTestId('contract-upload-open')).toHaveText(
      'Nahrát podepsaný originál revize 3',
    );
  });

  test("another salesperson never sees the draft or the prospect's drafts", async ({
    page,
    browser,
    baseURL,
  }) => {
    const email = `e2e-sales-${crypto.randomUUID().slice(0, 6)}@ayvo.test`;
    await json(
      await page.request.post('/api/admin/identity/users', {
        data: {
          email,
          displayName: 'Cizí obchodník (E2E)',
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'e2e: another salesperson',
        },
      }),
    );
    const ctx = await browser.newContext({ baseURL });
    const other = await ctx.newPage();
    await other.goto(`/api/auth/login?next=/sales&login_hint=${encodeURIComponent(email)}`);
    await expect(other).toHaveURL(/\/sales$/);
    for (const path of [
      `/api/admin/contracts/drafts/${draft}`,
      `/api/admin/contracts/drafts/${draft}/revisions/1/pdf`,
      `/api/admin/contracts/drafts?prospect=${prospect}`,
    ])
      expect((await other.request.get(path)).status(), path).toBe(404);
    expect((await other.request.get(`/api/admin/contracts/drafts?hotel=${hotel}`)).status()).toBe(
      403,
    );
    const res = await other.goto(`/sales/contracts/${draft}`);
    expect(res?.status()).toBe(404);
    await ctx.close();
  });
});
