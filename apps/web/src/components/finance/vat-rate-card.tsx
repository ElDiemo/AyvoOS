import type { DomesticVatRatePage } from '@ayvo/types';
import { VatRateForm } from '@/components/finance/issuer-forms';
import { Card, Notice } from '@/components/ui';
import { issuerCs as t } from '@/i18n/cs/finance-issuer';

export type VatRatePanel =
  { state: 'ok'; data: DomesticVatRatePage } | { state: 'forbidden' } | { state: 'unavailable' };

const when = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const day = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};
const percent = (v: string) => v.replace('.', ',');

/**
 * "Výchozí sazba DPH pro tuzemské faktury" (doc 040 §17) as its own panel (doc 044 U2): an older
 * Finance without the endpoint (404), an outage or a refusal says the rate is out of reach and
 * offers no form — never "no rate", and never takes the issuer and accounts down with it.
 */
export function VatRateCard({ panel }: { panel: VatRatePanel }) {
  if (panel.state !== 'ok')
    return (
      <Card title={t.vat.title} testId="issuer-vat-rate">
        <div data-testid="vat-rate-unavailable">
          <Notice tone="warning">
            {panel.state === 'forbidden' ? t.vat.forbidden : t.vat.unavailable}
          </Notice>
        </div>
      </Card>
    );
  const vat = panel.data;
  const effective = new Set(vat.effective.map((r) => r.revision));
  return (
    <Card title={t.vat.title} testId="issuer-vat-rate">
      <p className="mb-3 text-sm text-stone-600">{t.vat.intro}</p>
      <div className="mb-3 text-sm" data-testid="vat-rate-current">
        {vat.current ? (
          t.vat.current(percent(vat.current.ratePercent), day(vat.current.validFrom))
        ) : (
          <Notice>
            {vat.versions.length === 0 ? t.vat.none : t.vat.noneToday(day(vat.today))}
          </Notice>
        )}
      </div>
      {vat.effective.length > 0 && (
        <div className="mb-3 text-sm">
          <span className="font-medium">{t.vat.scheduled}</span>
          <ul className="mt-1" data-testid="vat-rate-effective">
            {vat.effective.map((r) => (
              <li key={r.revision}>{t.vat.entry(percent(r.ratePercent), day(r.validFrom))}</li>
            ))}
          </ul>
        </div>
      )}
      <VatRateForm
        key={vat.versions[0]?.revision ?? 0}
        revision={vat.versions[0]?.revision ?? null}
      />
      {vat.versions.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-stone-600">{t.vat.history}</summary>
          <ul className="mt-2 divide-y divide-stone-100" data-testid="vat-rate-history">
            {vat.versions.map((v) => (
              <li key={v.revision} className="py-2 wrap-anywhere">
                <span className="font-medium">
                  {t.vat.entry(percent(v.ratePercent), day(v.validFrom))}
                </span>{' '}
                · {when(v.recordedAt)} · {v.recordedByName} — {v.reason}
                {!effective.has(v.revision) && (
                  <span className="block text-stone-500">{t.vat.corrected}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
