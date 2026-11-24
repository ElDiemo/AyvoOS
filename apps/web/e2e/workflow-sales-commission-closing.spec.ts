import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import type { AdminUserDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

/**
 * Obchod → Provize → Měsíční provize / Moje provize (doc 069 §5–§6) with synthetic TEST invoices
 * of the last closed month M (and one of M-1). The admin's default view is the monthly overview:
 * one row per salesperson and currency with its current state (Čeká na schválení, K dořešení, K
 * fakturaci, Faktura přijata), the blocking flags in the first layer, the hotel rows in the
 * detail, a stale approval refused, approve → record the invoice on the same backend, and an
 * approved month whose preview is empty is never "nothing to close". A salesperson's default view
 * is their own commission: one state, one instruction, today's hotel count from the portfolio
 * (not the statement's), the invoiced amount as history and never "Vyplaceno". 1440 and 390 px
 * without sideways scrolling, also with 22 hotels. Runs after the issuer spec (the TEST invoices
 * need the issuer and its default CZK account).
 */
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const person = (key: string, name: string) => ({
  email: `e2e-uzaverka-${key}-${tag}@ayvo.test`.toLowerCase(),
  name: `${name} Uzávěrka ${tag}`,
});
const A = person('a', 'Alena');
const B = person('b', 'Bohdan');
const C = person('c', 'Cecílie');
const D = person('d', 'Dušan');
const ids: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' };
const ADMIN_STATE = 'e2e/.auth/admin.json';
const MANY = 22;

const today = pragueDay();
const current = today.slice(0, 7);
const prev = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};
/** The last closed month (M): the month before today's in Prague; and the one before it. */
const M = prev(current);
const M1 = prev(M);
const monthCs = (m: string) => `${Number(m.slice(5))}/${m.slice(0, 4)}`;
/** doc 069 payout rule for a receipt today (in M+1): by the 10th → the 15th, else next month's. */
const payout = (() => {
  const [cy, cm] = current.split('-').map(Number) as [number, number];
  const day = Number(today.slice(8, 10));
  const [y, m] = day <= 10 ? [cy, cm] : cm === 12 ? [cy + 1, 1] : [cy, cm + 1];
  return `15. ${m}. ${y}`;
})();
const row = (page: Page, who: 'a' | 'b' | 'c' | 'd') => page.getByTestId(`row-${ids[who]}-CZK`);

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

/** One TEST invoice of a month with a line per given hotel (a summary invoice for several). */
async function issue(request: APIRequestContext, keys: string[], month = M) {
  const effective = await json<{
    items: {
      agreement: { code: string };
      version: { revision: number; billedRooms: number };
      customer: { version: number };
      price: { perRoomMonth: string; priceListVersionId: string | null };
    }[];
  }>(await request.get(`/api/admin/finance/billing/agreements/effective?month=${month}`));
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
      data: { requestId: crypto.randomUUID(), month, lines },
    }),
  );
}

async function terms(request: APIRequestContext, salespersonId: string) {
  await json(
    await request.post('/api/admin/sales/commission-terms', {
      data: {
        requestId: crypto.randomUUID(),
        salespersonId,
        expectedVersion: 0,
        initialRate: '10',
        initialMonths: 24,
        maintenanceRate: '5',
        reason: 'smlouva o spolupráci (E2E uzávěrka)',
        confirm: true,
      },
    }),
  );
}

async function adminPage(browser: Browser): Promise<Page> {
  const admin = await browser.newContext({ storageState: ADMIN_STATE });
  const page = await admin.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  return page;
}

async function approve(page: Page, who: 'a' | 'b' | 'c' | 'd') {
  await row(page, who).getByTestId(`approve-${ids[who]}`).click();
  await page
    .getByTestId(`approve-${ids[who]}-dialog`)
    .getByRole('button', { name: 'Schválit' })
    .click();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await browser.newContext({ storageState: ADMIN_STATE });
  const request = admin.request;
  for (const [key, u] of [
    ['a', A],
    ['b', B],
    ['c', C],
    ['d', D],
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
  // No terms for B: his hotel is flagged "Chybí podmínky provize" and blocks his approval.
  for (const id of [ids.a, ids.c, ids.d]) await terms(request, id);
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
  await newHotel(request, 'D1', ids.d);
  await newHotel(request, 'X', null);
  const many = Array.from({ length: MANY }, (_, i) => `C${i + 1}`);
  for (const k of many) await newHotel(request, k, ids.c);
  // A summary invoice of two of A's hotels, one of B's, one nobody owns, 22 of C's; D in M-1.
  await issue(request, ['A1', 'A2']);
  await issue(request, ['B1']);
  await issue(request, ['X']);
  await issue(request, many);
  await issue(request, ['D1'], M1);
  await admin.close();
});

test('the admin: the monthly overview by default, the states, the detail and a stale approval', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.goto('/sales/commissions');
  await expect(page.getByTestId('tab-closing')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('closing-month')).toHaveValue(M);
  await expect(page.getByTestId('closing-steps')).toContainText(
    '1. Zkontrolujte→2. Schvalte→3. Zaevidujte fakturu',
  );

  // The current month is not closed: said truthfully, nothing to approve.
  await page.goto(`/sales/commissions?tab=closing&month=${current}`);
  await expect(page.getByTestId('closing-not-closed')).toContainText(
    `Měsíc ${monthCs(current)} ještě není uzavřený`,
  );
  await expect(page.locator('[data-testid^="approve-"]')).toHaveCount(0);
  await expect(page.getByTestId('closing-empty')).toHaveCount(0);

  // LIVE: no live invoice kind exists — an empty month, said with the mode.
  await page.goto(`/sales/commissions?tab=closing&month=${M}&mode=LIVE`);
  await expect(page.getByTestId('closing-live-badge')).toContainText('Režim: LIVE');
  await expect(page.getByTestId('closing-empty')).toContainText('Ostré faktury zatím neexistují');

  await page.goto(`/sales/commissions?tab=closing&month=${M}`);
  await expect(page.getByTestId('closing-test-badge')).toContainText('Režim: TEST');
  const a = row(page, 'a');
  await expect(a.getByTestId(`row-${ids.a}-CZK-state`)).toHaveText('Čeká na schválení');
  await expect(a.getByTestId(`row-${ids.a}-CZK-hotels`)).toContainText('2 hotely');
  await expect(a.getByTestId(`approve-${ids.a}`)).toBeVisible();
  // B: blocked, and the reason is in the first layer (not only in the detail).
  const b = row(page, 'b');
  await expect(b.getByTestId(`row-${ids.b}-CZK-state`)).toHaveText('K dořešení');
  await expect(b.getByTestId(`row-${ids.b}-CZK-flags`)).toBeVisible();
  await expect(b.getByTestId(`row-${ids.b}-CZK-flags`)).toContainText('Chybí podmínky provize');
  await expect(b.getByTestId(`approve-${ids.b}-blocked`)).toBeVisible();
  await expect(b.getByTestId(`approve-${ids.b}`)).toHaveCount(0);
  // Nothing computed for B yet: no "0,00" that would read as a real amount.
  await expect(b.getByTestId(`row-${ids.b}-CZK-amount-pending`)).toHaveText(
    'Částka se spočítá po vyřešení',
  );
  await expect(b.getByTestId(`row-${ids.b}-CZK-amount`)).toHaveCount(0);
  // D: M-1 is not approved yet, so his line blocks M (approve the earlier month first).
  const d = row(page, 'd');
  await expect(d.getByTestId(`row-${ids.d}-CZK-state`)).toHaveText('K dořešení');
  await expect(d.getByTestId(`row-${ids.d}-CZK-flags`)).toContainText(monthCs(M1));
  await expect(d.getByTestId(`row-${ids.d}-CZK-flags-open-${M1}`)).toHaveAttribute(
    'href',
    `/sales/commissions?tab=closing&month=${M1}&mode=TEST`,
  );
  // C: 22 hotels stay one row; the hotel rows only in the detail.
  const c = row(page, 'c');
  await expect(c.getByTestId(`row-${ids.c}-CZK-hotels`)).toContainText(`${MANY} hotelů`);
  await expect(c.getByTestId(`row-${ids.c}-CZK-items`)).toBeHidden();
  await c.getByTestId(`row-${ids.c}-CZK-detail`).locator('summary').click();
  await expect(c.getByTestId(`row-${ids.c}-CZK-items`).locator('tbody tr')).toHaveCount(MANY);
  await expect(page.getByTestId('closing-unresolved')).toContainText(hotels.X!.code);
  await expect(page.getByTestId('closing-empty')).toHaveCount(0);
  await noOverflow(page);
  await shot(page, 'sales-closing-overview-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'sales-closing-overview-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  // A new invoice of A's third hotel after the overview was loaded: the approval is refused.
  await issue(page.request, ['A3']);
  await approve(page, 'a');
  await expect(a.getByRole('alert')).toContainText('Podklady se mezitím změnily');
  await expect(a.getByTestId(`row-${ids.a}-CZK-state`)).toHaveText('Čeká na schválení');
  await page.context().close();
});

test('approve → record the invoice: the state always comes from the server', async ({
  browser,
}) => {
  const page = await adminPage(browser);
  await page.goto(`/sales/commissions?month=${M}`);
  const a = row(page, 'a');
  await expect(a.getByTestId(`row-${ids.a}-CZK-hotels`)).toContainText('3 hotely');
  const toInvoice = (await a.getByTestId(`row-${ids.a}-CZK-amount`).innerText()).trim();
  expect(toInvoice).toMatch(/^\d[\d\s]*,\d{2}\sCZK$/);
  await approve(page, 'a');

  // One row for A, now approved — from the refreshed server answer.
  await expect(a.getByTestId(`row-${ids.a}-CZK-state`)).toHaveText('K fakturaci');
  await expect(page.locator(`[data-testid="row-${ids.a}-CZK"]`)).toHaveCount(1);
  await expect(a.getByTestId(`row-${ids.a}-CZK-amount`)).toHaveText(toInvoice);
  await expect(a).toContainText('K fakturaci (bez DPH)');
  await expect(row(page, 'b').getByTestId(`row-${ids.b}-CZK-state`)).toHaveText('K dořešení');

  // The salesperson invoice: one action; a wrong base is refused in Czech.
  await a.getByTestId(`row-${ids.a}-CZK-invoice-action`).locator('summary').click();
  const form = a.getByTestId('si-form');
  await expect(form).toContainText('Vystavitel, doklad ani DPH se nekontrolují');
  await form.getByTestId('si-invoiceNumber').fill(`FO-${tag}`);
  await form.getByTestId('si-issuedOn').fill(today);
  await form.getByTestId('si-base').fill('1,00');
  await form.getByTestId('si-save').click();
  await expect(form.getByRole('alert')).toContainText('se musí rovnat částce k fakturaci');
  await form.getByTestId('si-base').fill(toInvoice.replace(/\sCZK$/, ''));
  await form.getByTestId('si-save').click();
  await expect(a.getByTestId(`row-${ids.a}-CZK-state`)).toHaveText('Faktura přijata');
  await expect(a.getByTestId(`row-${ids.a}-CZK-payout`)).toHaveText(payout);
  await expect(a).toContainText('Fakturováno (bez DPH)');
  await expect(a).toContainText('jen plán, nic se neplatí');
  await expect(a.getByTestId('si-form')).toHaveCount(0);
  await a.getByTestId(`row-${ids.a}-CZK-detail`).locator('summary').click();
  await expect(a.getByTestId(`row-${ids.a}-CZK-invoice`)).toContainText(`FO-${tag}`);

  // C approved too (K fakturaci for the salesperson view below).
  await approve(page, 'c');
  await expect(row(page, 'c').getByTestId(`row-${ids.c}-CZK-state`)).toHaveText('K fakturaci');
  await expect(page.getByRole('main')).not.toContainText('Vyplaceno');
  await expect(page.getByTestId('closing-empty')).toHaveCount(0);
  await noOverflow(page);
  await shot(page, 'sales-closing-states-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(row(page, 'a').getByTestId(`row-${ids.a}-CZK-payout`)).toHaveText(payout);
  await noOverflow(page);
  await shot(page, 'sales-closing-states-390');
  await page.context().close();
});

test('an approved month is shown once, never as "nothing to close"', async ({ browser }) => {
  const page = await adminPage(browser);
  // From D's blocking flag in M straight to the earlier open month.
  await page.goto(`/sales/commissions?month=${M}`);
  await page.getByTestId(`row-${ids.d}-CZK-flags-open-${M1}`).click();
  await expect(page.getByTestId('closing-month')).toHaveValue(M1);
  const d = row(page, 'd');
  await expect(d.getByTestId(`row-${ids.d}-CZK-state`)).toHaveText('Čeká na schválení');
  await approve(page, 'd');
  await expect(d.getByTestId(`row-${ids.d}-CZK-state`)).toHaveText('K fakturaci');
  await expect(page.locator(`[data-testid="row-${ids.d}-CZK"]`)).toHaveCount(1);
  await expect(page.getByTestId('closing-empty')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('nemá žádný obchodník nic k uzávěrce');
  // M-1 approved: D's line no longer blocks M.
  await page.goto(`/sales/commissions?month=${M}`);
  await expect(page.getByTestId(`row-${ids.d}-CZK`)).toHaveCount(0);
  await page.context().close();
});

test('a salesperson: own commission by default, one instruction, never the closing', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  await page.goto('/sales/commissions');
  await expect(page.getByTestId('tab-closing')).toHaveCount(0);
  await expect(page.getByTestId('tab-statement')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('mine-statement')).toContainText(
    `Moje provize · podklad ${monthCs(M)}`,
  );
  await expect(page.getByTestId('mine-test-badge')).toBeVisible();
  await expect(page.getByTestId('mine-state')).toHaveText('Faktura přijata');
  await expect(page.getByTestId('mine-instruction')).toHaveText(
    'Faktura je přijatá. Nic dalšího nedělejte.',
  );
  // After the invoice: the amount is history, never an instruction to invoice again.
  await expect(page.getByTestId('mine-amount')).toHaveCount(0);
  await expect(page.getByTestId('mine-invoiced')).toBeVisible();
  await expect(page.getByTestId('mine-payout')).toHaveText(payout);
  await expect(page.getByTestId('mine-hotels-now')).toContainText(
    `Aktuálně máte přiřazeno 3 hotely (portfolio ${monthCs(current)})`,
  );
  const main = page.getByRole('main');
  for (const hidden of [
    'Vyplaceno',
    'Částka k fakturaci',
    'Vystavte fakturu',
    B.name,
    hotels.A1!.code,
    hotels.X!.code,
  ])
    await expect(main).not.toContainText(hidden);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'sales-mine-received-390');

  // Older links keep working; the closing and the settings are not reachable by URL, nor the API.
  await page.goto(`/sales/commissions?tab=statement&month=${M}`);
  await expect(page.getByTestId('mine-state')).toHaveText('Faktura přijata');
  await page.goto('/sales/commissions?tab=portfolio');
  await expect(page.getByTestId('portfolio-filter')).toBeVisible();
  await page.goto(`/sales/commissions?tab=closing&month=${M}`);
  await expect(page).toHaveURL(/\/forbidden/);
  await page.goto('/sales/commissions?tab=settings');
  await expect(page).toHaveURL(/\/forbidden/);
  expect(
    (await page.request.get(`/api/admin/finance/commissions/preview?month=${M}`)).status(),
  ).toBe(403);
  await page.context().close();

  // C: approved, not invoiced — one instruction with the amount; 22 hotels only as a count.
  const c = await signIn(browser, C.email);
  await c.setViewportSize({ width: 390, height: 844 });
  await c.goto('/sales/commissions');
  await expect(c.getByTestId('mine-state')).toHaveText('K fakturaci');
  const amount = (await c.getByTestId('mine-amount').innerText()).trim();
  await expect(c.getByTestId('mine-instruction')).toHaveText(
    `Vystavte fakturu na ${amount} bez DPH.`,
  );
  await expect(c.getByTestId('mine-hotels-now')).toContainText(`${MANY} hotelů`);
  await expect(c.getByRole('main')).not.toContainText(hotels.C1!.code);
  await noOverflow(c);
  await shot(c, 'sales-mine-to-invoice-390');
  await c.setViewportSize({ width: 1440, height: 900 });
  await shot(c, 'sales-mine-to-invoice-1440');
  await c.context().close();

  // B: not approved (flagged) — "Zpracovává se", no amount, his own hotel count.
  const b = await signIn(browser, B.email);
  await b.goto(`/sales/commissions?tab=statement&month=${M}`);
  await expect(b.getByTestId('mine-state')).toHaveText('Zpracovává se');
  await expect(b.getByTestId('mine-instruction')).toContainText('Zatím nic nefakturujte');
  await expect(b.getByTestId('mine-amount')).toHaveCount(0);
  await expect(b.getByTestId('mine-hotels-now')).toContainText('přiřazeno 1 hotel ');
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
