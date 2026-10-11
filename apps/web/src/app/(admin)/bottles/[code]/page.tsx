import {
  bottleCodeSchema,
  bottleDetailSchema,
  bottlePhysicalSchema,
  labelDesignerSettingsSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { QrCode } from '@/components/qr-code';
import { BottleStatusBadge } from '@/components/status';
import { buttonClass, Card, Field, FieldList, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

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
      <PageHeader
        title={<span className="font-mono">{bottle.code}</span>}
        subtitle="Reusable AYVO bottle"
        back={{ href: '/bottles', label: 'Bottles' }}
      />
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="flex flex-col gap-6">
          <Card title="Overview">
            <FieldList>
              <Field label="Status">
                <BottleStatusBadge status={bottle.status} />
              </Field>
              <Field label="Reuse cycles">
                <span className="tabular-nums" data-testid="reuse-cycles">
                  {bottle.reuseCycles}
                </span>
              </Field>
              <Field label="Created at">{formatDateTime(bottle.createdAt)}</Field>
              <Field label="Label">{bottle.labelTemplate.label}</Field>
              <Field label="Created in series">
                <Link
                  href={`/batches/${bottle.creationBatchCode}`}
                  className="font-mono text-stone-600 hover:underline"
                >
                  {bottle.creationBatchCode}
                </Link>
              </Field>
            </FieldList>
          </Card>
          <Card title="Physical bottle">
            <div data-testid="physical">
              {applied ? (
                <FieldList>
                  <Field label="Label applied">{formatDateTime(applied.appliedAt)}</Field>
                  <Field label="Body from lot">
                    <Link
                      href={`/warehouse/movements?lotId=${applied.lot.id}`}
                      className="font-mono hover:underline"
                    >
                      {applied.lot.code}
                    </Link>
                  </Field>
                  {applied.receipt && (
                    <Field label="Goods receipt">
                      <Link
                        href={`/warehouse/receipts/${applied.receipt.code}`}
                        className="font-mono hover:underline"
                      >
                        {applied.receipt.code}
                      </Link>{' '}
                      line {applied.receipt.lineNo}
                      {applied.supplier ? ` · ${applied.supplier.name}` : ''}
                    </Field>
                  )}
                </FieldList>
              ) : (
                <p className="text-sm text-stone-600">
                  Identity and label only — the printed label has not been applied to a physical
                  bottle yet.
                </p>
              )}
              {physical.components.length > 0 && (
                <>
                  <h3 className="mt-4 mb-2 text-xs font-medium uppercase tracking-wide text-stone-500">
                    Component history
                  </h3>
                  <ul className="flex flex-col gap-1 text-sm" data-testid="components">
                    {physical.components.map((c, i) => (
                      <li key={i} className="wrap-anywhere">
                        {c.type} · {c.printJobCode ?? '—'} · installed{' '}
                        {formatDateTime(c.installedAt)}
                        {c.removedAt
                          ? ` · removed ${formatDateTime(c.removedAt)} (${c.disposition}: ${c.removalReason})`
                          : ' · installed now'}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
          <Card title="Lifecycle">
            <ol className="relative ml-2 border-l border-stone-200" data-testid="lifecycle">
              {bottle.events.map((event, i) => (
                <li key={i} className="mb-4 ml-5 last:mb-0">
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-stone-900" />
                  <p className="text-sm font-medium">{event.type}</p>
                  <p className="text-xs text-stone-500">{formatDateTime(event.occurredAt)}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title="QR code">
          <QrCode
            value={bottle.publicUrl}
            level={settings.qrErrorCorrection}
            className="mx-auto w-full max-w-56"
            title={`QR code of ${bottle.code}`}
          />
          <a
            href={bottle.publicUrl}
            target="_blank"
            rel="noopener"
            className={`${buttonClass.secondary} mt-4 w-full`}
          >
            Open passport
          </a>
          <p className="mt-3 text-xs text-stone-500">
            The QR code encodes only this stable public URL:
          </p>
          <p className="mt-1 break-all font-mono text-xs" data-testid="public-url">
            {bottle.publicUrl}
          </p>
        </Card>
      </div>
    </>
  );
}
