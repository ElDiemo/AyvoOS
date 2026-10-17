import {
  catalogCodeSchema,
  catalogComponentSchema,
  crateTypeMeasurementsSchema,
  type CrateDimension,
} from '@ayvo/types';
import { z } from 'zod';
import { notFound } from 'next/navigation';
import { CatalogHeader } from '@/components/catalog/catalog-header';
import { Card } from '@/components/ui';
import { WeightForm } from '@/components/weights/weight-form';
import { CurrentMeasurement, WeightHistory } from '@/components/weights/weight-history';
import { catalogCs } from '@/i18n/cs/catalog';
import { weightsCs } from '@/i18n/cs/weights';
import { apiGet } from '@/lib/api';
import { formatDimensions, formatMass } from '@/lib/measure';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = weightsCs.crateType;

function dims(d: CrateDimension): string {
  const base = formatDimensions(d.lengthMm, d.widthMm, d.heightMm);
  if (d.subject === 'CRATE' || !d.extraPackaging) return base;
  if (d.extraPackaging === 'NONE') return `${base} · ${t.packaging.NONE}`;
  // A catalogue packaging item brings its own (current) weight; otherwise the mass entered here.
  const mass = d.extraItem
    ? `${d.extraItem.name}: ${formatMass(d.extraItem.massG) ?? weightsCs.unknown}`
    : (formatMass(d.extraMassG) ?? weightsCs.unknown);
  return `${base} · ${t.packaging[d.extraPackaging]} (${d.extraDescription}), ${t.extraMass.toLowerCase()} ${mass} · ${d.extraInTare ? t.inTare : t.notInTare}`;
}

/** A crate type with its measured tare and dimensions (doc 025 §10, W1). */
export default async function CrateTypePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!catalogCodeSchema.safeParse(code).success) notFound();
  const [me, m, tz, components] = await Promise.all([
    currentUser(),
    apiGet(
      `admin/catalog/crate-types/${encodeURIComponent(code)}/measurements`,
      crateTypeMeasurementsSchema,
    ),
    siteTimeZone(),
    apiGet('admin/catalog/components', z.array(catalogComponentSchema)),
  ]);
  const packagingItems = components
    .filter((c) => c.kind === 'PACKAGING' && !c.archived)
    .map((c) => ({ code: c.code, name: c.name }));
  const canRecord = hasPermission(me, 'catalog:weights_record');
  const base = `admin/catalog/crate-types/${encodeURIComponent(m.crateType.code)}`;
  const tareValue = (e: { massG: string; configuration: string }) =>
    `${formatMass(e.massG)} · ${e.configuration}`;
  return (
    <>
      <CatalogHeader
        view={null}
        title={m.crateType.name}
        subtitle={
          <span className="font-mono" data-testid="crate-type-code">
            {m.crateType.code} · {catalogCs.crateTypes.capacity} {m.crateType.capacity}
          </span>
        }
        back={{ href: '/production/catalog/crate-types', label: catalogCs.common.back }}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t.tare} testId="crate-tare">
          <CurrentMeasurement
            value={m.tare.current ? tareValue(m.tare.current) : null}
            entry={m.tare.current}
            testId="crate-tare-current"
          />
          <WeightHistory
            entries={m.tare.history}
            value={tareValue}
            timeZone={tz}
            testId="crate-tare-history"
          />
        </Card>
        {canRecord && (
          <WeightForm
            path={`${base}/tare`}
            form={{ kind: 'tare' }}
            title={`${weightsCs.form.record}: ${t.tare}`}
            currentId={m.tare.current?.id ?? null}
            testId="tare-form"
          />
        )}
        <Card title={t.crate} testId="crate-dims">
          <CurrentMeasurement
            value={m.crate.current ? dims(m.crate.current) : null}
            entry={m.crate.current}
            testId="crate-dims-current"
          />
          <WeightHistory
            entries={m.crate.history}
            value={dims}
            timeZone={tz}
            testId="crate-dims-history"
          />
        </Card>
        {canRecord && (
          <WeightForm
            path={`${base}/dimensions`}
            form={{ kind: 'dimensions', subject: 'CRATE' }}
            title={`${weightsCs.form.record}: ${t.crate}`}
            currentId={m.crate.current?.id ?? null}
            testId="crate-dims-form"
          />
        )}
        <Card title={t.package} testId="package-dims">
          <CurrentMeasurement
            value={m.package.current ? dims(m.package.current) : null}
            entry={m.package.current}
            testId="package-dims-current"
          />
          <WeightHistory
            entries={m.package.history}
            value={dims}
            timeZone={tz}
            testId="package-dims-history"
          />
        </Card>
        {canRecord && (
          <WeightForm
            path={`${base}/dimensions`}
            form={{ kind: 'dimensions', subject: 'SHIPPING_PACKAGE', packagingItems }}
            title={`${weightsCs.form.record}: ${t.package}`}
            currentId={m.package.current?.id ?? null}
            testId="package-dims-form"
          />
        )}
        {!canRecord && <p className="text-xs text-stone-500">{weightsCs.readOnly}</p>}
      </div>
    </>
  );
}
