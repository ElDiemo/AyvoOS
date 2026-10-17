import type { ProductWeights } from '@ayvo/types';
import { Card } from '@/components/ui';
import { WeightForm } from '@/components/weights/weight-form';
import { CurrentMeasurement, WeightHistory } from '@/components/weights/weight-history';
import { unitCs } from '@/i18n/cs/format';
import { weightsCs } from '@/i18n/cs/weights';
import { formatMass } from '@/lib/measure';

const t = weightsCs.product;

/**
 * Hmotnost hotové lahve, the expected (reference) weight of a full crate and the components as a
 * separate cross-check (doc 025 §10). Reference ≠ actual weighing; unknown stays "neznámá".
 */
export function ProductWeightsCard({
  w,
  canRecord,
  timeZone,
}: {
  w: ProductWeights;
  canRecord: boolean;
  timeZone: string;
}) {
  const e = w.expectation;
  const bottleValue = (x: { massG: string; bottlesWeighed: number; recipeVersion: number }) =>
    t.versionValue(x.recipeVersion, formatMass(x.massG)!, x.bottlesWeighed);
  const unknown = <span className="font-semibold">{weightsCs.unknown}</span>;
  return (
    <>
      <Card title={t.title} testId="product-weight">
        <p className="mb-2 text-xs text-stone-500">{t.help}</p>
        <p className="mb-2 text-xs text-stone-500">{t.perVersion}</p>
        <CurrentMeasurement
          value={w.current ? bottleValue(w.current) : null}
          entry={w.current}
          testId="product-weight-current"
        />
        <WeightHistory
          entries={w.history}
          value={bottleValue}
          timeZone={timeZone}
          testId="product-weight-history"
        />
        {!canRecord && <p className="mt-3 text-xs text-stone-500">{weightsCs.readOnly}</p>}
      </Card>
      {canRecord && w.versions.length > 0 && (
        <WeightForm
          path={`admin/catalog/products/${encodeURIComponent(w.product.code)}/weights`}
          form={{
            kind: 'product',
            versions: w.versions,
            latest: Object.fromEntries(
              [...w.history].reverse().map((h) => [h.recipeVersion, h.id] as const),
            ),
          }}
          title={`${weightsCs.form.record}: ${t.title}`}
          currentId={null}
          testId="product-weight-form"
        />
      )}
      <Card title={t.expectedTitle} testId="crate-expectation">
        <p className="mb-3 text-xs text-stone-500">{t.expectedHelp}</p>
        {!e.crateType ? (
          <p className="text-sm text-stone-600">{t.noRecipe}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-stone-500">{t.crate}</dt>
              <dd className="text-xl font-semibold tabular-nums" data-testid="expected-crate">
                {formatMass(e.expectedCrateG) ?? unknown}
              </dd>
              <dd className="text-xs text-stone-500">
                {t.formula(
                  e.crateType.capacity,
                  formatMass(e.bottleG) ?? weightsCs.unknown,
                  formatMass(e.tareG) ?? weightsCs.unknown,
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">{t.package}</dt>
              <dd className="text-xl font-semibold tabular-nums" data-testid="expected-package">
                {formatMass(e.expectedPackageG) ?? unknown}
              </dd>
              <dd className="text-xs text-stone-500">
                {weightsCs.packagingState[e.packaging.state]}
              </dd>
            </div>
          </dl>
        )}
        {e.missing.length > 0 && (
          <p className="mt-3 text-sm text-amber-900" data-testid="expected-missing">
            {t.missing} {e.missing.map((m) => t.missingItem[m]).join(', ')}
          </p>
        )}
      </Card>
      {e.components.lines.length > 0 && (
        <Card title={t.componentsTitle} testId="components-check">
          <p className="mb-3 text-xs text-stone-500">{t.componentsHelp}</p>
          <ul className="flex flex-col divide-y divide-stone-100 text-sm">
            {e.components.lines.map((l) => (
              <li key={l.item.code} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>
                  {l.item.name}{' '}
                  <span className="text-xs text-stone-500">
                    ({l.quantity.replace('.', ',')} {unitCs(l.unitCode)})
                  </span>
                </span>
                <span className="tabular-nums">{formatMass(l.massG) ?? weightsCs.unknown}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm font-medium" data-testid="components-sum">
            {t.componentsSum}:{' '}
            {e.components.sumG
              ? formatMass(e.components.sumG)
              : t.componentsUnknown(e.components.unknown.join(', '))}
          </p>
        </Card>
      )}
    </>
  );
}
