import {
  bottleCodeSchema,
  bottleDetailSchema,
  bottlePhysicalSchema,
  labelDesignerSettingsSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProductionHeader } from '@/components/production/production-header';
import { QrCode } from '@/components/qr-code';
import { BottleStatusBadge } from '@/components/status';
import { buttonClass, Card, Field, FieldList } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';

const t = productionCs.bottle;

export const dynamic = 'force-dynamic';

export default async function BottlePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // A malformed code can never exist: answer 404 instead of asking the API (which says 400).
  if (!bottleCodeSchema.safeParse(code).success) notFound();
  const [bottle, settings, physical] = await Promise.all([
    apiGet(`admin/bottles/${encodeURIComponent(code)}`, bottleDetailSchema),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
    apiGet(`admin/bottles/${encodeURIComponent(code)}/physical`, bottlePhysicalSchema),
  ]);
  const applied = physical.labelApplication;
  return (
    <>
      <ProductionHeader
        active="bottles"
        title={<span className="font-mono">{bottle.code}</span>}
        subtitle={t.subtitle}
        back={{ href: '/bottles', label: t.back }}
      />
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="flex flex-col gap-6">
          <Card title={t.overview}>
            <FieldList>
              <Field label={t.status}>
                <BottleStatusBadge status={bottle.status} />
              </Field>
              <Field label={t.reuseCycles}>
                <span className="tabular-nums" data-testid="reuse-cycles">
                  {bottle.reuseCycles}
                </span>
              </Field>
              <Field label={t.createdAt}>{formatDateTimeCs(bottle.createdAt)}</Field>
              <Field label={t.label}>{bottle.labelTemplate.label}</Field>
              <Field label={t.series}>
                <Link
                  href={`/batches/${bottle.creationBatchCode}`}
                  className="font-mono text-stone-600 hover:underline"
                >
                  {bottle.creationBatchCode}
                </Link>
              </Field>
            </FieldList>
          </Card>
          <Card title={t.physical}>
            <div data-testid="physical">
              {applied ? (
                <FieldList>
                  <Field label={t.labelApplied}>{formatDateTimeCs(applied.appliedAt)}</Field>
                  <Field label={t.bodyFromLot}>
                    <Link
                      href={`/warehouse/movements?lotId=${applied.lot.id}`}
                      className="font-mono hover:underline"
                    >
                      {applied.lot.code}
                    </Link>
                  </Field>
                  {applied.receipt && (
                    <Field label={t.receipt}>
                      <Link
                        href={`/warehouse/receipts/${applied.receipt.code}`}
                        className="font-mono hover:underline"
                      >
                        {applied.receipt.code}
                      </Link>{' '}
                      {t.receiptLine(applied.receipt.lineNo)}
                      {applied.supplier ? ` · ${applied.supplier.name}` : ''}
                    </Field>
                  )}
                </FieldList>
              ) : (
                <p className="text-sm text-stone-600">{t.notApplied}</p>
              )}
              {physical.components.length > 0 && (
                <>
                  <h3 className="mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
                    {t.components}
                  </h3>
                  <ul className="flex flex-col gap-1 text-sm" data-testid="components">
                    {physical.components.map((c, i) => (
                      <li key={i} className="wrap-anywhere">
                        {t.componentType[c.type] ?? c.type} · {c.printJobCode ?? '—'} ·{' '}
                        {t.installed(formatDateTimeCs(c.installedAt))}
                        {c.removedAt
                          ? ` · ${t.removed(formatDateTimeCs(c.removedAt))} (${c.disposition}: ${c.removalReason})`
                          : ` · ${t.installedNow}`}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
          <Card title={t.lifecycle}>
            <ol className="relative ml-2 border-l border-stone-200" data-testid="lifecycle">
              {bottle.events.map((event, i) => (
                <li key={i} className="mb-4 ml-5 last:mb-0">
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-900" />
                  <p className="text-sm font-medium">
                    {productionCs.eventType[event.type] ?? event.type}
                  </p>
                  <p className="text-xs text-stone-500">{formatDateTimeCs(event.occurredAt)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title={t.qr}>
          <QrCode
            value={bottle.publicUrl}
            level={settings.qrErrorCorrection}
            className="mx-auto w-full max-w-56"
            title={t.qrTitle(bottle.code)}
          />
          <a
            href={bottle.publicUrl}
            target="_blank"
            rel="noopener"
            className={`${buttonClass.secondary} mt-4 w-full`}
          >
            {t.openPassport}
          </a>
          <p className="mt-3 text-xs text-stone-500">{t.qrHelp}</p>
          <p className="mt-1 break-all font-mono text-xs" data-testid="public-url">
            {bottle.publicUrl}
          </p>
        </Card>
      </div>
    </>
  );
}
