import {
  labelDesignerSettingsSchema,
  labelTemplateDetailSchema,
  type LabelDesignerSettings,
  type LabelTemplateVersion,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { QrCode } from '@/components/qr-code';
import { TemplateArchiveButton } from '@/components/label-templates/template-archive-button';
import { buttonClass, Card, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatMm } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function LabelTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { saved } = await searchParams;
  const [template, settings] = await Promise.all([
    apiGet(`admin/label-templates/${encodeURIComponent(id)}`, labelTemplateDetailSchema),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
  ]);
  const [latest, ...older] = template.versions;

  return (
    <>
      <PageHeader
        title={template.name}
        subtitle={`Label template · ${template.versions.length} version${template.versions.length === 1 ? '' : 's'}`}
        back={{ href: '/label-templates', label: 'Label templates' }}
        actions={
          <>
            <TemplateArchiveButton templateId={template.id} archived={!!template.archivedAt} />
            {!template.archivedAt && (
              <>
                <Link
                  href={`/label-templates/${template.id}/new-version`}
                  className={buttonClass.secondary}
                >
                  Edit (new version)
                </Link>
                <Link
                  href={`/bottles/new?version=${latest!.versionId}`}
                  className={buttonClass.primary}
                >
                  Create bottles with {latest!.label}
                </Link>
              </>
            )}
          </>
        }
      />
      {saved && (
        <p
          role="status"
          className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 wrap-anywhere"
        >
          Saved as {template.name} v{saved}.
        </p>
      )}
      {template.archivedAt && (
        <p
          role="status"
          className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Archived {formatDateTime(template.archivedAt)}: kept for reproducing historical labels,
          not selectable for new bottles.
        </p>
      )}
      <div className="flex flex-col gap-6">
        <VersionCard version={latest!} settings={settings} current />
        {older.map((v) => (
          <VersionCard key={v.versionId} version={v} settings={settings} />
        ))}
      </div>
    </>
  );
}

/** Static preview: artwork + QR exactly where the PDF puts it (positions in % of the label). */
function VersionCard({
  version,
  settings,
  current = false,
}: {
  version: LabelTemplateVersion;
  /** Preview URL of THIS environment (never a production URL outside production). */
  settings: LabelDesignerSettings;
  current?: boolean;
}) {
  const qr = version.elements[0];
  return (
    <Card>
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <div
          className="relative w-full overflow-hidden bg-white shadow ring-1 ring-stone-200"
          style={{ aspectRatio: `${version.widthMm} / ${version.heightMm}` }}
          data-testid={`version-preview-${version.versionNumber}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={version.artwork.contentUrl}
            alt=""
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: 'fill' }}
          />
          {qr && (
            <div
              className="absolute"
              style={{
                left: `${(qr.xMm / version.widthMm) * 100}%`,
                top: `${(qr.yMm / version.heightMm) * 100}%`,
                width: `${(qr.widthMm / version.widthMm) * 100}%`,
                height: `${(qr.heightMm / version.heightMm) * 100}%`,
              }}
            >
              <QrCode
                value={settings.qrPreviewUrl}
                level={settings.qrErrorCorrection}
                className="h-full w-full"
                title="QR position"
              />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold wrap-anywhere">
            {version.label}
            {current && (
              <span className="ml-2 rounded-full bg-stone-900 px-2 py-0.5 text-xs font-medium text-white">
                current
              </span>
            )}
          </h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-stone-500">Label size</dt>
            <dd>
              {formatMm(version.widthMm)} × {formatMm(version.heightMm)}
            </dd>
            <dt className="text-stone-500">Artwork</dt>
            <dd>
              {version.artwork.originalFilename} ({version.artwork.format})
            </dd>
            {qr && (
              <>
                <dt className="text-stone-500">QR code</dt>
                <dd>
                  X {formatMm(qr.xMm)} · Y {formatMm(qr.yMm)} · {formatMm(qr.widthMm)} ×{' '}
                  {formatMm(qr.heightMm)}
                </dd>
              </>
            )}
            <dt className="text-stone-500">Saved</dt>
            <dd>{formatDateTime(version.createdAt)}</dd>
          </dl>
          <a
            href={`/api/admin/label-template-versions/${version.versionId}/calibration.pdf`}
            className="text-sm font-medium text-stone-700 underline"
            download
          >
            Calibration PDF (print at 100 %)
          </a>
          <p className="text-xs text-stone-400">
            Versions are immutable: labels printed with this version can always be reproduced.
          </p>
        </div>
      </div>
    </Card>
  );
}
