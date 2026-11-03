import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGetPanel = vi.fn();
vi.mock('@/lib/api', () => ({ apiGetPanel: (...args: unknown[]) => apiGetPanel(...args) }));
const { HotelBillingPanel } = await import('./hotel-billing-panel');

const render = async (canBilling: boolean, canInvoices: boolean) =>
  renderToStaticMarkup(
    await HotelBillingPanel({ hotelId: 'h', canBilling, canInvoices, canManage: false }),
  );
const answer = (billing: unknown, invoices: unknown) =>
  apiGetPanel.mockImplementation((path: string) =>
    Promise.resolve(path.includes('by-hotel') ? billing : invoices),
  );
const noAgreement = { state: 'ok', data: { month: '2026-11', terms: null } };

describe('the hotel card names the part out of reach, never an empty card', () => {
  beforeEach(() => {
    apiGetPanel.mockReset();
  });

  it('a 403 from both parts says so for each', async () => {
    answer({ state: 'forbidden' }, { state: 'forbidden' });
    const html = await render(true, true);
    expect(html).toContain('hotel-billing-forbidden-terms');
    expect(html).toContain('hotel-billing-forbidden-invoices');
    expect(html).not.toContain('Hotel zatím nemá');
  });
  it('invoices only: the contract is out of reach, not missing; the invoices have their way on', async () => {
    answer(null, { state: 'ok', data: [] });
    const html = await render(false, true);
    expect(html).toContain('hotel-billing-forbidden-terms');
    expect(html).not.toContain('hotel-billing-forbidden-invoices');
    expect(html).toContain('Hotel zatím nemá žádnou fakturu');
    expect(apiGetPanel).toHaveBeenCalledTimes(1);
  });
  it('contract only: the invoices are out of reach, not missing', async () => {
    answer(noAgreement, null);
    const html = await render(true, false);
    expect(html).toContain('hotel-billing-forbidden-invoices');
    expect(html).toContain('Hotel zatím nemá fakturační podmínky');
  });
  it('unavailable stays its own answer, not missing rights', async () => {
    answer({ state: 'unavailable' }, { state: 'unavailable' });
    const html = await render(true, true);
    expect(html).toContain('dočasně nedostupná');
    expect(html).not.toContain('forbidden');
  });
});
