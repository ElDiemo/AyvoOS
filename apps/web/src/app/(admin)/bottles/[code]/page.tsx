import { bottleDetailSchema, labelDesignerSettingsSchema } from '@ayvo/types';
import Link from 'next/link';
import { QrCode } from '@/components/qr-code';
import { BottleStatusBadge } from '@/components/status';
import { Card, Field, FieldList, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BottlePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [bottle, settings] = await Promise.all([
    apiGet(`admin/bottles/${encodeURIComponent(code)}`, bottleDetailSchema),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
  ]);
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{bottle.code}</span>}
        subtitle="Reusable AYVO bottle"
        back={{ href: '/bottles', label: 'Bottles' }}
      />
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div className="flex flex-col gap-6">
          <Card title="Identity">
            <FieldList>
              <Field label="Status">
                <BottleStatusBadge status={bottle.status} />
              </Field>
              <Field label="Creation batch">
                <Link
                  href={`/batches/${bottle.creationBatchCode}`}
                  className="font-mono hover:underline"
                >
                  {bottle.creationBatchCode}
                </Link>
              </Field>
              <Field label="Label">{bottle.labelTemplate.label}</Field>
              <Field label="Public URL">
                <a
                  href={bottle.publicUrl}
                  className="break-all font-mono text-xs hover:underline"
                  data-testid="public-url"
                >
                  {bottle.publicUrl}
                </a>
              </Field>
              <Field label="Registered">{formatDateTime(bottle.createdAt)}</Field>
            </FieldList>
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
            className="w-full"
            title={`QR code of ${bottle.code}`}
          />
          <p className="mt-3 text-xs text-stone-500">Encodes only the stable public URL above.</p>
        </Card>
      </div>
    </>
  );
}
