import { outsideBottlesSchema, type OutsideBottle } from '@ayvo/types';
import Link from 'next/link';
import { ProductionHeader } from '@/components/production/production-header';
import { BottleStatusBadge } from '@/components/status';
import { Card, EmptyState } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs;

/**
 * Výroba → Bedny → Lahve mimo bednu (doc 025 §3.3, A5): labelled bottles of the active site in no
 * crate — labelled empties, finished bottles (they keep FILLED and their liquid lot) and bottles
 * labelled before crates were recorded — with the crate they left, when and why.
 */
export default async function OutsideBottlesPage() {
  const [data, timeZone] = await Promise.all([
    apiGet('admin/bottles-outside-crates', outsideBottlesSchema),
    siteTimeZone(),
  ]);
  const group = (key: 'labelledEmpty' | 'finished' | 'legacy', title: string, help?: string) => (
    <Card title={title} testId={`outside-${key}`}>
      {help && <p className="mb-3 text-xs text-stone-500">{help}</p>}
      {data[key].length === 0 ? (
        <EmptyState>{t.outside.none}</EmptyState>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-stone-100 text-sm">
            {data[key].map((b) => (
              <Row key={b.code} bottle={b} timeZone={timeZone} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500">
            {t.outside.shown(data[key].length, data.totals[key])}
          </p>
        </>
      )}
    </Card>
  );
  return (
    <>
      <ProductionHeader
        active="crates"
        title={t.outside.title}
        subtitle={t.outside.subtitle}
        back={{ href: '/production/crates', label: t.backToList }}
      />
      <div className="flex flex-col gap-6">
        {group('finished', t.outside.finished)}
        {group('labelledEmpty', t.outside.labelledEmpty)}
        {group('legacy', t.outside.legacy, t.outside.legacyHelp)}
      </div>
    </>
  );
}

function Row({ bottle: b, timeZone }: { bottle: OutsideBottle; timeZone: string }) {
  return (
    <li
      className="grid grid-cols-1 gap-x-4 gap-y-1 py-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] md:items-center"
      data-testid={`outside-${b.code}`}
    >
      <Link href={`/bottles/${b.code}`} className="font-mono underline-offset-2 hover:underline">
        {b.code}
      </Link>
      <BottleStatusBadge status={b.status} />
      <span className="text-xs text-stone-600">
        {[
          b.product && `${b.product.name}${b.recipeVersion ? ` · v${b.recipeVersion}` : ''}`,
          b.design,
          b.liquidLot && t.outside.lot(b.liquidLot),
          b.lastCrate &&
            b.leftAt &&
            t.outside.lastCrate(b.lastCrate, formatDateTimeCs(b.leftAt, timeZone)),
          b.reason && t.outside.reason(b.reason),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  );
}
