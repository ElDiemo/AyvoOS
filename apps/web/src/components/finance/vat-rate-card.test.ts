import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The form is a client component (router); here only whether it is offered.
vi.mock('@/components/finance/issuer-forms', () => ({ VatRateForm: () => 'VAT-RATE-FORM' }));
const { VatRateCard } = await import('./vat-rate-card');

const render = (panel: Parameters<typeof VatRateCard>[0]['panel']) =>
  renderToStaticMarkup(VatRateCard({ panel }));
const rate = {
  revision: 7,
  validFrom: '2026-01-01',
  ratePercent: '21.00',
  reason: 'Sazba podle správce (test)',
  recordedAt: '2026-01-01T08:00:00.000Z',
  recordedByName: 'Správce',
};

describe('the VAT-rate block of Naše firma a účty (doc 040 §17)', () => {
  it('out of reach (an older Finance answering 404, an outage): says so, offers no form', () => {
    const html = render({ state: 'unavailable' });
    expect(html).toContain('vat-rate-unavailable');
    expect(html).toContain('nelze načíst');
    expect(html).not.toContain('VAT-RATE-FORM');
    // Never read as "no rate".
    expect(html).not.toContain('Sazba DPH není zadaná');
    expect(html).not.toContain('vat-rate-current');
  });
  it('refused: its own answer, no form', () => {
    const html = render({ state: 'forbidden' });
    expect(html).toContain('nemáte oprávnění');
    expect(html).not.toContain('VAT-RATE-FORM');
  });
  it('an ordinary answer without any rate: none entered, the form offered', () => {
    const html = render({
      state: 'ok',
      data: { today: '2026-11-03', current: null, effective: [], versions: [] },
    });
    expect(html).toContain('Sazba DPH není zadaná');
    expect(html).toContain('VAT-RATE-FORM');
    expect(html).not.toContain('vat-rate-unavailable');
  });
  it('an ordinary answer with a rate: today, by start day, the history', () => {
    const html = render({
      state: 'ok',
      data: { today: '2026-11-03', current: rate, effective: [rate], versions: [rate] },
    });
    expect(html).toContain('Dnes platí 21,00 % (od 1. 1. 2026)');
    expect(html).toContain('vat-rate-history');
    expect(html).toContain('VAT-RATE-FORM');
  });
});
