import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/** Screenshots for the PR, only when asked for (STAFF_SCREENSHOTS=<dir>). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.STAFF_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}-${page.viewportSize()!.width}.png`),
    fullPage: true,
  });
};

/**
 * Hotely → Uživatelé in the browser: a hotel portal account (issued through Finance's payer page
 * contract) is not an internal user — not in Správa systému → Uživatelé, its internal detail is
 * not found — and is shown under Hotely → Uživatelé with its hotel and payer; it is deactivated,
 * reactivated and its access revoked there. Synthetic data only.
 */
test.describe('Hotely → Uživatelé', () => {
  test.use({ storageState: ADMIN_STATE });

  async function setup(request: APIRequestContext, run: string) {
    const me = (await (await request.get('/api/auth/me')).json()) as {
      sites: { id: string; code: string }[];
    };
    const hotelRes = await request.post('/api/admin/hotels', {
      data: {
        requestId: crypto.randomUUID(),
        name: `Hotel Portál ${run} (E2E)`,
        addressLine1: 'Portálová 1',
        addressLine2: null,
        postalCode: '779 00',
        city: 'Olomouc',
        countryCode: 'CZ',
        contactName: 'Recepce',
        contactPhone: '+420 500 000 009',
        contactEmail: 'recepce@portal.test',
        fulfillmentSiteId: me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
      },
    });
    expect(hotelRes.ok(), await hotelRes.text()).toBe(true);
    const hotel = (await hotelRes.json()) as { id: string; code: string; name: string };
    const customerRes = await request.post('/api/admin/finance/billing/customers', {
      data: {
        requestId: crypto.randomUUID(),
        customer: {
          legalName: `Portál ${run} s.r.o. (E2E)`,
          companyId: '12345678',
          vatId: null,
          addressLine1: 'Portálová 1',
          addressLine2: null,
          postalCode: '779 00',
          city: 'Olomouc',
          countryCode: 'CZ',
          billingEmail: 'fakturace@portal.test',
          documentLanguage: 'cs',
        },
      },
    });
    expect(customerRes.ok(), await customerRes.text()).toBe(true);
    const customer = (await customerRes.json()) as { id: string; code: string };
    const terms = (over: Record<string, unknown> = {}) => ({
      effectiveFrom: '2026-01',
      customerId: customer.id,
      contractNumber: null,
      billedRooms: 10,
      ownPricePerRoomMonth: null,
      currency: 'CZK',
      paymentTermsDays: 14,
      billingTiming: 'ARREARS',
      validFrom: '2026-01-01',
      validTo: null,
      reason: 'Smlouva (syntetická)',
      ...over,
    });
    const agreementRes = await request.post('/api/admin/finance/billing/agreements', {
      data: { requestId: crypto.randomUUID(), hotelId: hotel.id, terms: terms() },
    });
    expect(agreementRes.ok(), await agreementRes.text()).toBe(true);
    return { hotel, customer };
  }

  for (const width of [390, 1440]) {
    test(`a portal account apart from internal users, managed under Hotely at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const run = crypto.randomUUID().slice(0, 6);
      const { hotel, customer } = await setup(page.request, run);
      const email = `recepce-${run}@portal-e2e.test`;
      const issued = await page.request.post('/api/admin/finance/portal-grants', {
        data: {
          requestId: crypto.randomUUID(),
          payerCustomerId: customer.id,
          email,
          displayName: `Recepce ${run}`,
          hotelIds: [hotel.id],
          reason: 'Přístup recepce (E2E)',
        },
      });
      expect(issued.ok(), await issued.text()).toBe(true);
      const { account, grant } = (await issued.json()) as {
        account: { userId: string };
        grant: { id: string };
      };

      // Not an internal user.
      await page.goto('/admin/users');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(email)).toHaveCount(0);
      const internal = await page.request.get(`/api/admin/identity/users/${account.userId}`);
      expect(internal.status()).toBe(404);

      // Hotely → Uživatelé.
      await page.goto('/hotels/users');
      await expect(page.getByRole('heading', { level: 1, name: 'Uživatelé' })).toBeVisible();
      const card = page.getByTestId(`portal-account-${account.userId}`);
      await expect(card).toContainText(email);
      await expect(card).toContainText(hotel.name);
      await expect(card).toContainText(`Portál ${run} s.r.o. (E2E)`);
      await expect(card).toContainText('Aktivní');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await shot(page, 'hotel-users');

      // The hotel's card: the assigned account, its state, and where to manage or invite.
      await page.goto(`/hotels/${hotel.code}`);
      await page
        .getByTestId('hotel-sections')
        .getByRole('link', { name: 'Přístup do portálu' })
        .click();
      const section = page.getByTestId('hotel-portal-access');
      const row = section.getByTestId(`hotel-portal-account-${account.userId}`);
      await expect(row).toContainText(email);
      await expect(row).toContainText('Aktivní');
      await expect(row).toContainText(`Portál ${run} s.r.o. (E2E)`);
      // An assignment, never a claim of operational rights (review 5841786998 pending).
      await expect(section).not.toContainText('provozní přístup');
      await expect(section.getByTestId('hotel-portal-access-invite')).toHaveAttribute(
        'href',
        `/finance/billing/customers/${customer.code}#pristup-do-portalu`,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await shot(page, 'hotel-portal-access');
      await row.getByRole('link', { name: `Recepce ${run}` }).click();
      await expect(page.getByRole('heading', { level: 1, name: `Recepce ${run}` })).toBeVisible();
      // From the account: each assigned hotel, and the payer's page to manage the access.
      await expect(
        page.getByTestId(`portal-grant-${grant.id}`).getByRole('link', { name: hotel.name }),
      ).toHaveAttribute('href', `/hotels/${hotel.code}#pristup-do-portalu`);
      await expect(page.getByTestId(`portal-grant-manage-${grant.id}`)).toHaveAttribute(
        'href',
        `/finance/billing/customers/${customer.code}#pristup-do-portalu`,
      );
      await page.goto('/hotels/users');
      await card.getByRole('link', { name: `Recepce ${run}` }).click();
      await expect(page.getByRole('heading', { level: 1, name: `Recepce ${run}` })).toBeVisible();
      const within = (testId: string) =>
        page.locator('details', { has: page.getByTestId(testId) }).locator('[name=reason]');
      await page.getByTestId('portal-account-deactivate').click();
      await within('portal-account-deactivate').fill('Konec spolupráce (E2E)');
      await page.getByTestId('portal-account-deactivate-confirm').click();
      await expect(page.getByTestId(`portal-account-${account.userId}`)).toContainText(
        'Deaktivovaný',
      );
      await page.getByTestId('portal-account-reactivate').click();
      await within('portal-account-reactivate').fill('Obnovení spolupráce (E2E)');
      await page.getByTestId('portal-account-reactivate-confirm').click();
      await expect(page.getByTestId(`portal-account-${account.userId}`)).toContainText('Aktivní');

      await page.getByTestId(`portal-grant-revoke-${grant.id}`).click();
      await page
        .getByTestId(`portal-grant-${grant.id}`)
        .locator('[name=reason]')
        .fill('Konec přístupu (E2E)');
      await page.getByTestId(`portal-grant-revoke-${grant.id}-confirm`).click();
      await expect(page.getByText('Žádný aktivní přístup.')).toBeVisible();
      await expect(page.getByText('Odvolané přístupy (1)')).toBeVisible();
      await shot(page, 'hotel-user-detail');
    });
  }

  test.describe('without the grant administrators’ permission', () => {
    test.use({ storageState: OPERATOR_STATE });

    test('no portal section, account list or e-mail on the hotel card, the tab or the account', async ({
      page,
      browser,
    }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const run = crypto.randomUUID().slice(0, 6);
      const admin = await browser.newContext({ storageState: ADMIN_STATE });
      const { hotel, customer } = await setup(admin.request, run);
      const email = `recepce-${run}@portal-e2e.test`;
      const issued = await admin.request.post('/api/admin/finance/portal-grants', {
        data: {
          requestId: crypto.randomUUID(),
          payerCustomerId: customer.id,
          email,
          displayName: `Recepce ${run}`,
          hotelIds: [hotel.id],
          reason: 'Přístup recepce (E2E)',
        },
      });
      expect(issued.ok(), await issued.text()).toBe(true);
      const { account } = (await issued.json()) as { account: { userId: string } };
      await admin.close();
      await page.goto(`/hotels/${hotel.code}`);
      // The e2e operator has no hotels:read either: the page itself is refused.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('hotel-portal-access')).toHaveCount(0);
      expect(await page.content()).not.toContain(email);
      for (const url of ['/hotels/users', `/hotels/users/${account.userId}`]) {
        await page.goto(url);
        await expect(page.getByTestId('hotel-portal-access')).toHaveCount(0);
        expect(await page.content()).not.toContain(email);
      }
      const api = await page.request.get(`/api/admin/identity/portal-accounts?hotelId=${hotel.id}`);
      expect(api.status()).toBe(403);
      expect(await api.text()).not.toContain(email);
    });
  });
});
