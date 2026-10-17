import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { weightsCs as t } from '@/i18n/cs/weights';

type Entry = {
  id: string;
  measuredOn: string;
  method: string;
  recordedAt: string;
  recordedBy: string;
  correctionOf: string | null;
  correctionReason: string | null;
};

/** The measurement history, newest first; corrections keep the corrected value visible. */
export function WeightHistory<E extends Entry>({
  entries,
  value,
  timeZone,
  testId,
}: {
  entries: E[];
  value: (e: E) => React.ReactNode;
  timeZone: string;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <details className="mt-3 text-sm" data-testid={testId}>
      <summary className="cursor-pointer text-stone-600">
        {t.history} ({entries.length})
      </summary>
      <ol className="mt-2 flex flex-col divide-y divide-stone-100">
        {entries.map((e) => (
          <li key={e.id} className="py-2">
            <span className="font-medium">{value(e)}</span>
            <span className="block text-xs text-stone-600">
              {t.measuredOn} {formatDateCs(e.measuredOn)} · {e.method}
            </span>
            <span className="block text-xs text-stone-500">
              {t.recorded(e.recordedBy, formatDateTimeCs(e.recordedAt, timeZone))}
              {e.correctionOf && ` · ${t.correctionOf}`}
              {e.correctionReason && ` · ${t.correctionReason(e.correctionReason)}`}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The current measurement with its date and method, or "neznámá". */
export function CurrentMeasurement({
  value,
  entry,
  testId,
}: {
  value: React.ReactNode | null;
  entry: Entry | null;
  testId: string;
}) {
  if (!entry || value === null) {
    return (
      <p className="text-sm text-stone-600" data-testid={testId} data-state="unknown">
        <span className="font-semibold">{t.unknown}</span> – {t.notMeasured}
      </p>
    );
  }
  return (
    <p className="text-sm" data-testid={testId} data-state="known">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="block text-xs text-stone-600">
        {t.measuredOn} {formatDateCs(entry.measuredOn)} · {entry.method}
      </span>
    </p>
  );
}
