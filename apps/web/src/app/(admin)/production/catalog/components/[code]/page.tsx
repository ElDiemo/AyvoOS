import { catalogCodeSchema, itemWeightsSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { CatalogHeader } from '@/components/catalog/catalog-header';
import { Card, Notice } from '@/components/ui';
import { WeightForm } from '@/components/weights/weight-form';
import { CurrentMeasurement, WeightHistory } from '@/components/weights/weight-history';
import { catalogCs } from '@/i18n/cs/catalog';
import { unitCs } from '@/i18n/cs/format';
import { weightsCs } from '@/i18n/cs/weights';
import { apiGet } from '@/lib/api';
import { formatMass } from '@/lib/measure';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = weightsCs.item;

/** A component with its measured reference weight (doc 025 §10, W1). */
export default async function ComponentPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!catalogCodeSchema.safeParse(code).success) notFound();
  const [me, w, tz] = await Promise.all([
    currentUser(),
    apiGet(`admin/catalog/components/${encodeURIComponent(code)}/weights`, itemWeightsSchema),
    siteTimeZone(),
  ]);
  const unit = unitCs(w.item.unit.code);
  const value = (e: { massG: string; sampleVolume: string | null }) =>
    e.sampleVolume
      ? t.sampleValue(formatMass(e.massG)!, e.sampleVolume.replace('.', ','), unit)
      : `${formatMass(e.massG)} / 1 ${unit}`;
  const canRecord = hasPermission(me, 'catalog:weights_record') && w.mode !== 'NOT_APPLICABLE';
  return (
    <>
      <CatalogHeader
        view={null}
        title={w.item.name}
        subtitle={
          <span className="font-mono" data-testid="component-code">
            {w.item.code} ·{' '}
            {(catalogCs.kinds as Record<string, string>)[w.item.kind] ?? w.item.kind}
          </span>
        }
        back={{ href: '/production/catalog/components', label: catalogCs.common.back }}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t.title} testId="component-weight">
          {w.mode === 'NOT_APPLICABLE' ? (
            <Notice tone="info">{t.notApplicable}</Notice>
          ) : (
            <>
              <CurrentMeasurement
                value={w.current ? value(w.current) : null}
                entry={w.current}
                testId="component-weight-current"
              />
              {w.mode === 'SAMPLE' && <p className="mt-2 text-xs text-stone-500">{t.sampleHelp}</p>}
              <WeightHistory
                entries={w.history}
                value={value}
                timeZone={tz}
                testId="component-weight-history"
              />
              {!canRecord && <p className="mt-3 text-xs text-stone-500">{weightsCs.readOnly}</p>}
            </>
          )}
        </Card>
        {canRecord && (
          <WeightForm
            path={`admin/catalog/components/${encodeURIComponent(w.item.code)}/weights`}
            form={{
              kind: 'item',
              mode: w.mode === 'SAMPLE' ? 'SAMPLE' : 'PER_UNIT',
              unitCode: unit,
            }}
            title={weightsCs.form.record}
            currentId={w.current?.id ?? null}
            testId="component-weight-form"
          />
        )}
      </div>
    </>
  );
}
