import type { HotelChange } from '@ayvo/types';
import { Card, EmptyState } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { hotelsCs } from '@/i18n/cs/hotels';

const t = hotelsCs.changes;

/**
 * "Historie změn údajů": who changed the hotel's details, when and why — AYVO staff or the hotel
 * itself in the portal (its reason is required) — and what changed. Never a reason to hide: the
 * values shown are the hotel's own contact details already on this page.
 */
export function HotelChanges({
  changes,
  timeZone,
}: {
  changes: HotelChange[] | null;
  timeZone: string;
}) {
  return (
    <Card title={t.title} testId="hotel-changes">
      {changes === null ? (
        <p className="text-sm text-amber-800">{t.unavailable}</p>
      ) : changes.length === 0 ? (
        <EmptyState>{t.empty}</EmptyState>
      ) : (
        <ul className="flex flex-col">
          {changes.map((c) => (
            <li
              key={c.at + (c.by ?? '')}
              className="flex flex-col gap-1 border-t border-stone-100 py-3 text-sm first:border-t-0 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    c.via === 'PORTAL'
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-stone-100 text-stone-700'
                  }`}
                >
                  {t.via[c.via]}
                </span>
                <span className="text-stone-600">
                  {formatDateTimeCs(c.at, timeZone)}
                  {c.by && ` · ${c.by}`}
                </span>
              </div>
              {c.reason && (
                <p>
                  <span className="text-stone-500">{t.reason}: </span>
                  {c.reason}
                </p>
              )}
              <ul className="flex flex-col gap-0.5 text-xs text-stone-700">
                {c.changes.map((f) => (
                  <li key={f.field}>
                    <span className="font-medium">{t.fields[f.field] ?? f.field}:</span>{' '}
                    <span className="text-stone-500 line-through">{f.before ?? t.blank}</span>{' '}
                    <span aria-hidden="true">→</span> {f.after ?? t.blank}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
