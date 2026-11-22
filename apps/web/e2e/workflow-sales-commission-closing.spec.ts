import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { AdminUserDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

/**
 * Obchod → Provize → Uzávěrka / Můj podklad (doc 069 §5–§6, PR 2e) with synthetic TEST invoices of
 * the last closed month: the admin sees the preview per salesperson, the deviations (a missing
 * terms flag that blocks, a hotel nobody owns), a stale approval refused after a new invoice, the
 * approval, and records the salesperson's invoice with the planned payout day. A salesperson sees
 * only their own simple state, the hotel count and the one amount — never the closing; nothing is
 * ever "Vyplaceno". 1440 and 390 px without sideways scrolling. Runs after the issuer spec (the
 * TEST invoices need the issuer and its default CZK account).
 */
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const A = { email: `e2e-uzaverka-a-${tag}@ayvo.test`.toLowerCase(), name: `Alena Uzávěrka ${tag}` };
const B = {
  email: `e2e-uzaverka-b-${tag}@ayvo.test`.toLowerCase(),
  name: `Bohdan Uzávěrka ${tag}`,
};
const ids: Record<'a' | 'b', string> = { a: '', b: '' };
const ADMIN_STATE = 'e2e/.auth/admin.json';

const today = pragueDay();
const current = today.slice(0, 7);
const [cy, cm] = current.split('-').map(Number) as [number, number];
/** The last closed month (M): the month before today's in Prague. */
const M = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, '0')}`;
const monthCs = (m: string) => `${Number(m.slice(5))}/${m.slice(0, 4)}`;
/** doc 069 payout rule for a receipt today (in M+1): by the 10th → the 15th, else next month's. */
const payout = (() => {
  const day = Number(today.slice(8, 10));
  const [y, m] = day <= 10 ? [cy, cm] : cm === 12 ? [cy + 1, 1] : [cy, cm + 1];
  return `15. ${m}. ${y}`;
})();

let customerId = '';
let siteId = '';
const hotels: Record<string, { code: string; agreement: string }> = {};

async function newHotel(request: APIRequestContext, key: string, owner: string | null) {
  const hotel = await json<{ code: string }>(
    await request.post('/api/admin/hotels', {
      data: {
        requestId: crypto.randomUUID(),
        name: `Hotel Uzávěrka ${key} ${tag}`,
        addressLine1: 'Provizní 2',
        addressLine2: null,
        postalCode: '602 00',
        city: 'Brno',
        countryCode: 'CZ',
        contactName: 'Recepce',
        contactPhone: '+420 500 000 169',
        contactEmail: 'recepce@uzaverka.test',
        fulfillmentSiteId: siteId,
      },
    }),
  );
  if (owner)
    await json(
      await request.post(`/api/admin/hotels/${hotel.code}/sales-attribution`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: 0,
          salespersonId: owner,
          source: 'MANUAL',
          commissionStart: '2026-01',
          confirmCommissionStart: true,
          reason: 'stávající hotel (E2E uzávěrka)',
          confirm: true,
        },
      }),
    );
  const financeHotels = await json<{ id: string; code: string }[]>(
    await request.get('/api/admin/finance/billing/hotels'),
  );
  const agreement = await json<{ code: string }>(
    await request.post('/api/admin/finance/billing/agreements', {
      data: {
        requestId: crypto.randomUUID(),
        hotelId: financeHotels.find((h) => h.code === hotel.code)!.id,
        terms: {
          effectiveFrom: '2026-01',
          customerId,
          contractNumber: null,
          billedRooms: 12,
          ownPricePerRoomMonth: '350.00',
          currency: 'CZK',
          paymentTermsDays: 14,
          billingTiming: 'ARREARS',
          validFrom: '2026-01-01',
          validTo: null,
          reason: 'Smlouva (syntetická, E2E uzávěrka)',
        },
      },
    }),
  );
  hotels[key] = { code: hotel.code, agreement: agreement.code };
}

/** One TEST invoice of month M with a line per given hotel (a summary invoice for several). */
async function issue(request: APIRequestContext, keys: string[]) {
  const effective = await json<{
    items: {
      agreement: { code: string };
      version: { revision: number; billedRooms: number };
      customer: { version: number };
      price: { perRoomMonth: string; priceListVersionId: string | null };
    }[];
  }>(await request.get(`/api/admin/finance/billing/agreements/effective?month=${M}`));
  const lines = keys.map((k) => {
    const shown = effective.items.find((i) => i.agreement.code === hotels[k]!.agreement)!;
    return {
      agreementCode: shown.agreement.code,
      agreementRevision: shown.version.revision,
      customerVersion: shown.customer.version,
      priceListVersionId: shown.price.priceListVersionId,
      unitPrice: shown.price.perRoomMonth,
      billedRooms: shown.version.billedRooms,
    };
  });
  return json<{ number: string }>(
    await request.post('/api/admin/finance/invoices/test', {
      data: { requestId: crypto.randomUUID(), month: M, lines },
    }),
  );
}

async function adminPage(browser: Browser): Promise<Page> {
  const admin = await browser.newContext({ storageState: ADMIN_STATE });
  const page = await admin.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  return page;
}

test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: ADMIN_STATE });
  const request = admin.request;
  for (const [key, u] of [
    ['a', A],
    ['b', B],
  ] as const) {
    ids[key] = (
      await json<AdminUserDetail>(
        await request.post('/api/admin/identity/users', {
          data: {
            email: u.email,
            displayName: u.name,
            roles: ['SALES'],
            siteIds: [],
            warehouseCodes: [],
            reason: 'obchodník (E2E uzávěrka)',
          },
        }),
      )
    ).id;
  }
  // Terms only for A: B's hotel is flagged "Chybí podmínky provize" and blocks his approval.
  await json(
    await request.post('/api/admin/sales/commission-terms', {
      data: {
        requestId: crypto.randomUUID(),
        salespersonId: ids.a,
        expectedVersion: 0,
        initialRate: '10',
        initialMonths: 24,
        maintenanceRate: '5',
        reason: 'smlouva o spolupráci (E2E uzávěrka)',
        confirm: true,
      },
    }),
  );
  const me = await json<{ sites: { id: string }[] }>(await request.get('/api/auth/me'));
  siteId = me.sites[0]!.id;
  customerId = (
    await json<{ id: string }>(
      await request.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: `Uzávěrka ${tag} s.r.o. (E2E)`,
            companyId: '22334455',
            vatId: null,
            addressLine1: 'Provizní 2',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@uzaverka.test',
            documentLanguage: 'cs',
          },
        },
      }),
    )
  ).id;
  await newHotel(request, 'A1', ids.a);
  await newHotel(request, 'A2', ids.a);
  await newHotel(request, 'A3', ids.a);
  await newHotel(request, 'B1', ids.b);
  await newHotel(request, 'X', null);
  // A summary invoice of two of A's hotels, one of B's, one of a hotel nobody owns.
  await issue(request, ['A1', 'A2']);
  await issue(request, ['B1']);
  await issue(request, ['X']);
  await admin.close();
});

test('the admin: an open month is said so, the preview, its deviations, a stale approval', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.goto('/sales/commissions');
  await page.getByTestId('tab-closing').click();
  await expect(page).toHaveURL(/tab=closing/);

  // The current month is not closed: said truthfully, nothing to approve.
  await page.goto(`/sales/commissions?tab=closing&month=${current}`);
  await expect(page.getByTestId('closing-not-closed')).toContainText(
    `Měsíc ${monthCs(current)} ještě není uzavřený`,
  );
  await expect(page.locator('[data-testid^="approve-"]')).toHaveCount(0);

  // LIVE: no live invoice kind exists — an empty preview, not an error.
  await page.goto(`/sales/commissions?tab=closing&month=${M}&mode=LIVE`);
  await expect(page.getByTestId('closing-preview')).toContainText('Ostré faktury zatím neexistují');

  await page.goto(`/sales/commissions?tab=closing&month=${M}`);
  await expect(page.getByTestId('closing-test-badge')).toBeVisible();
  const a = page.getByTestId(`preview-${ids.a}`);
  await expect(a).toContainText(`${A.name} · 2 hotely`);
  await expect(a.getByTestId(`preview-${ids.a}-deviations`)).toContainText('Bez odchylek');
  const b = page.getByTestId(`preview-${ids.b}`);
  await expect(b.getByTestId(`preview-${ids.b}-flag`)).toContainText('Chybí podmínky provize');
  await expect(b.getByTestId(`approve-${ids.b}-blocked`)).toBeVisible();
  await expect(b.getByTestId(`approve-${ids.b}`)).toHaveCount(0);
  await expect(page.getByTestId('closing-unresolved')).toContainText(`Nepřiřazený hotel: `);
  await expect(page.getByTestId('closing-unresolved')).toContainText(hotels.X!.code);
  await noOverflow(page);
  await shot(page, 'sales-closing-preview-1440');

  // A new invoice of A's third hotel after the preview was loaded: the approval is refused.
  await issue(page.request, ['A3']);
  await a.getByTestId(`approve-${ids.a}`).click();
  const dialog = page.getByTestId(`approve-${ids.a}-dialog`);
  await expect(dialog).toContainText('Schvaluje se přesně tento náhled');
  await dialog.getByRole('button', { name: 'Schválit' }).click();
  await expect(a.getByRole('alert')).toContainText('Podklady se mezitím změnily');
  await expect(page.getByTestId(`approved-${ids.a}`)).toHaveCount(0);
  await page.context().close();
});

test('the admin approves the reloaded preview and records the salesperson invoice', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.goto(`/sales/commissions?tab=closing&month=${M}`);
  const a = page.getByTestId(`preview-${ids.a}`);
  await expect(a).toContainText(`${A.name} · 3 hotely`);
  const toInvoice = (await a.getByTestId(`preview-${ids.a}-balance-to-invoice`).innerText()).trim();
  expect(toInvoice).toMatch(/^\d[\d\s]*,\d{2}\sCZK$/);
  await a.getByTestId(`approve-${ids.a}`).click();
  await page
    .getByTestId(`approve-${ids.a}-dialog`)
    .getByRole('button', { name: 'Schválit' })
    .click();

  const approved = page.getByTestId(`approved-${ids.a}`);
  await expect(approved).toContainText('Schváleno');
  await expect(approved.getByTestId(`approved-${ids.a}-balance-to-invoice`)).toHaveText(toInvoice);
  // Approved once: A is no longer in the preview of M; B still waits.
  await expect(page.getByTestId(`preview-${ids.a}`)).toHaveCount(0);
  await expect(page.getByTestId(`preview-${ids.b}`)).toBeVisible();

  // The salesperson invoice: the form says what is checked; a wrong base is refused in Czech.
  const form = approved.getByTestId('si-form');
  await expect(form).toContainText('Vystavitel, doklad ani DPH se nekontrolují');
  await form.getByTestId('si-invoiceNumber').fill(`FO-${tag}`);
  await form.getByTestId('si-issuedOn').fill(today);
  await form.getByTestId('si-base').fill('1,00');
  await form.getByTestId('si-save').click();
  await expect(form.getByRole('alert')).toContainText('se musí rovnat částce k fakturaci');
  await form.getByTestId('si-base').fill(toInvoice.replace(/\sCZK$/, ''));
  await form.getByTestId('si-save').click();
  await expect(approved.getByTestId(`approved-${ids.a}-payout`)).toHaveText(payout);
  await expect(approved).toContainText('nic se neplatí');
  await expect(page.getByRole('main')).not.toContainText('Vyplaceno');
  await noOverflow(page);
  await shot(page, 'sales-closing-approved-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(approved.getByTestId(`approved-${ids.a}-payout`)).toHaveText(payout);
  await noOverflow(page);
  await shot(page, 'sales-closing-approved-390');
  await page.context().close();
});

test('a salesperson sees only their own state and one amount, never the closing', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  await page.goto('/sales/commissions');
  await expect(page.getByTestId('tab-closing')).toHaveCount(0);
  await page.getByTestId('tab-statement').click();
  await expect(page.getByTestId('mine-statement')).toContainText(`Můj podklad ${monthCs(M)}`);
  await expect(page.getByTestId('mine-state')).toHaveText('Faktura přijata');
  await expect(page.getByTestId('mine-hotels')).toHaveText('3');
  await expect(page.getByTestId('mine-payout')).toHaveText(payout);
  const main = page.getByRole('main');
  for (const hidden of ['Vyplaceno', B.name, hotels.A1!.code, hotels.X!.code])
    await expect(main).not.toContainText(hidden);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'sales-closing-mine-390');

  // The closing is not reachable by URL, nor its API.
  await page.goto(`/sales/commissions?tab=closing&month=${M}`);
  await expect(page).toHaveURL(/\/forbidden/);
  expect(
    (await page.request.get(`/api/admin/finance/commissions/preview?month=${M}`)).status(),
  ).toBe(403);
  await page.context().close();

  // B: not approved (flagged) — "Zpracovává se", no amount, his own hotel count.
  const b = await signIn(browser, B.email);
  await b.goto(`/sales/commissions?tab=statement&month=${M}`);
  await expect(b.getByTestId('mine-state')).toHaveText('Zpracovává se');
  await expect(b.getByTestId('mine-amount')).toHaveCount(0);
  await expect(b.getByTestId('mine-hotels')).toHaveText('1');
  await expect(b.getByRole('main')).not.toContainText(A.name);
  await b.context().close();
});

test('without a session the page asks to sign in', async ({ browser }) => {
  // No stored session at all (the project's default is the operator's).
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/sales/commissions?tab=statement&month=${M}`);
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});
