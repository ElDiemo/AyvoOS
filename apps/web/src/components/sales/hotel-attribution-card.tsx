import { hotelAttributionSchema } from '@ayvo/types';
import { Card, Notice } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { apiGetPanel } from '@/lib/api';
import { monthCs, termsLine } from './commission-format';
import { HotelAttributionForm } from './hotel-attribution-form';

const t = commissionsCs.attribution;

/**
 * "Obchodník (provize)" on a hotel's card (doc 068 §12.1; sales:manage + hotels:read). Its own
 * panel: if it cannot be read, it says so and the rest of the card works. No amount, invoice or
 * payment — those come from Finance later.
 */
export async function HotelAttributionCard({ hotel }: { hotel: string }) {
  const res = await apiGetPanel(`admin/hotels/${hotel}/sales-attribution`, hotelAttributionSchema);
  if (res.state !== 'ok')
    return (
      <Card title={t.title} testId="hotel-attribution">
        <Notice tone="warning">{t.unavailable}</Notice>
      </Card>
    );
  const data = res.data;
  const current = data.history[0];
  const bound = (b: (typeof data.history)[number]['binding'], hasPerson: boolean) =>
    b ? (termsLine(b) ?? t.termsHidden) : hasPerson ? commissionsCs.missing : '—';
  return (
    <Card title={t.title} testId="hotel-attribution">
      <div className="flex flex-col gap-4">
        {current ? (
          <p className="text-sm" data-testid="attribution-current">
            <span className="text-stone-600">{t.current}: </span>
            <strong>{current.salesperson?.name ?? t.nobody}</strong>
            {' · '}
            {t.firstMonth.toLowerCase()} <strong>{monthCs(data.commissionStart!)}</strong>
            {' · '}
            {bound(current.binding, current.salesperson !== null)}
          </p>
        ) : (
          <p className="text-sm text-stone-600">{t.none}</p>
        )}
        <details open={!current} className="rounded-md border border-stone-200 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {current ? t.change : t.saveFirst}
          </summary>
          <div className="mt-3">
            <HotelAttributionForm key={data.revision} data={data} />
          </div>
        </details>
        {data.history.length > 0 && (
          <div className="overflow-x-auto">
            <h3 className="mb-1 text-sm font-medium">{t.history}</h3>
            <table className="w-full text-left text-sm" data-testid="attribution-history">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t.columns.from}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t.columns.who}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t.columns.source}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t.columns.terms}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t.columns.reason}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t.columns.recorded}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {data.history.map((r) => (
                  <tr key={r.revision}>
                    <td className="py-2 pr-4 tabular-nums">{monthCs(r.effectiveFrom)}</td>
                    <td className="py-2 pr-4">
                      {r.salesperson?.name ?? t.nobody}
                      {r.prefilledSalesperson &&
                        r.prefilledSalesperson.id !== r.salesperson?.id && (
                          <span className="block text-xs text-stone-500">
                            {t.offered(r.prefilledSalesperson.name)}
                          </span>
                        )}
                    </td>
                    <td className="py-2 pr-4">
                      {r.contract
                        ? `${r.contract.draftCode} rev. ${r.contract.revision}`
                        : t.sourceLabel[r.source]}
                      {r.startDiffersFromContract && r.contract && (
                        <span className="block text-xs text-amber-800">
                          {t.startDiffers(formatDateCs(r.contract.startOn))}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{bound(r.binding, r.salesperson !== null)}</td>
                    <td className="py-2 pr-4 wrap-anywhere">{r.reason}</td>
                    <td className="py-2 text-stone-600">
                      {formatDateTimeCs(r.recordedAt)} · {r.recordedByName}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
