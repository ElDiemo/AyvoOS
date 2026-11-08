import { expect, test, type APIRequestContext } from '@playwright/test';

const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * "Přístup do portálu" on a payer page (ADR 0045 §4, PR 4a) in the browser: a new access for a
 * hotel of the payer, then the payer's agreement ends — the access still shows its hotel by name
 * and is revoked from the same page. Synthetic data only.
 */
test.describe('Přístup do hotelového portálu', () => {
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
    const hotel = (await hotelRes.json()) as { id: string; name: string };
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
    const agreement = (await agreementRes.json()) as {
      code: string;
      versions: { revision: number }[];
    };
    /** The payer's agreement ends (a new version of the terms, valid only in the past). */
    const endAgreement = async () => {
      const res = await request.post(
        `/api/admin/finance/billing/agreements/${agreement.code}/versions`,
        {
          data: {
            requestId: crypto.randomUUID(),
            expectedRevision: agreement.versions[0]!.revision,
            terms: terms({ validTo: '2026-02-28', reason: 'Konec smlouvy (syntetický)' }),
          },
        },
      );
      expect(res.ok(), await res.text()).toBe(true);
    };
    return { hotel, customer, endAgreement };
  }

  test('a new access, then the agreement ends: the access keeps its hotel name and is revoked', async ({
    page,
  }) => {
    const run = crypto.randomUUID().slice(0, 6);
    const { hotel, customer, endAgreement } = await setup(page.request, run);
    const email = `recepce-${run}@portal-e2e.test`;

    await page.goto(`/finance/billing/customers/${customer.code}`);
    const card = page.getByTestId('portal-access');
    await expect(card).toContainText('Zatím nikdo nemá přístup.');
    await card.getByTestId('portal-access-open').click();
    const form = card.getByTestId('portal-access-new');
    await form.locator('[name=email]').fill(email);
    await form.locator('[name=displayName]').fill('Recepce Portál');
    await form.getByLabel(hotel.name).check();
    await form.locator('[name=reason]').fill('Přístup recepce (E2E)');
    await form.getByTestId('portal-access-save').click();
    await expect(form.getByRole('status')).toContainText('Přístup uložen');
    const list = card.getByTestId('portal-access-list');
    await expect(list).toContainText(email);
    await expect(list).toContainText(`Hotely: ${hotel.name}`);

    // The payer's agreement ends: no hotel is on offer any more, the access is still there.
    await endAgreement();
    await page.reload();
    await expect(card).toContainText('Plátce teď nemá žádný hotel');
    const grant = list.locator('li').filter({ hasText: email });
    await expect(grant).toContainText(`Hotely: ${hotel.name}`);
    await expect(grant).toContainText('Aktivní');
    await grant.getByText('Odvolat přístup').click();
    await grant.locator('[name=revokeReason]').fill('Konec spolupráce (E2E)');
    await grant.getByRole('button', { name: 'Odvolat', exact: true }).click();
    await expect(grant).toContainText('Odvolaný: Konec spolupráce (E2E)');
    await expect(grant.getByText('Odvolat přístup')).toHaveCount(0);
  });
});
