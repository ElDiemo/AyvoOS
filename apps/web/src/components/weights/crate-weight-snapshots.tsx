import type { CrateWeightSnapshot } from '@ayvo/types';
import { Card } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { weightsCs } from '@/i18n/cs/weights';
import { formatMass } from '@/lib/measure';

const t = weightsCs.snapshot;

/** The references kept at each Hotovo of a crate (doc 025 §10) — expectations, not a weighing. */
export function CrateWeightSnapshots({
  snapshots,
  timeZone,
}: {
  snapshots: CrateWeightSnapshot[];
  timeZone: string;
}) {
  const v = (g: string | null) => formatMass(g) ?? weightsCs.unknown;
  return (
    <Card title={t.title} testId="crate-weights" className="lg:col-span-2">
      <p className="mb-3 text-xs text-stone-500">{t.help}</p>
      {snapshots.length === 0 ? (
        <p className="text-sm text-stone-600">{t.none}</p>
      ) : (
        <ol className="flex flex-col gap-3 text-sm">
          {snapshots.map((s) => (
            <li
              key={s.takenAt}
              className="rounded-md border border-stone-200 p-3"
              data-testid="crate-weight-snapshot"
            >
              <p className="text-xs text-stone-500">
                {t.at(formatDateTimeCs(s.takenAt, timeZone))}
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-stone-500">{t.bottle}</dt>
                  <dd className="tabular-nums">
                    {v(s.bottleG)} × {s.bottles}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">{t.tare}</dt>
                  <dd className="tabular-nums">{v(s.tareG)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">{t.crate}</dt>
                  <dd className="font-semibold tabular-nums">{v(s.expectedCrateG)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-stone-500">{t.package}</dt>
                  <dd className="font-semibold tabular-nums">{v(s.expectedPackageG)}</dd>
                  <dd className="text-xs text-stone-500">
                    {weightsCs.packagingState[s.packaging]}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
