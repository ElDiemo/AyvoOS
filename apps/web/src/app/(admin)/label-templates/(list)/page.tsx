import { labelTemplateSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { buttonClass, Card, EmptyState, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatMm } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function LabelTemplatesPage() {
  const templates = await apiGet('admin/label-templates', z.array(labelTemplateSummarySchema));
  return (
    <>
      <PageHeader
        title="Label templates"
        subtitle="Reusable label designs. Every saved change becomes a new immutable version."
        actions={
          <>
            <a
              href="/api/admin/label-calibration/qr-validation-sheet.pdf"
              className={buttonClass.secondary}
              download
            >
              QR validation sheet (PDF)
            </a>
            <Link href="/label-templates/new" className={buttonClass.primary}>
              Create template
            </Link>
          </>
        }
      />
      <Card>
        {templates.length === 0 ? (
          <EmptyState>No label templates yet. Create the first one, e.g. “mydlo1”.</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100">
            {templates.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/label-templates/${t.id}`}
                  className="flex items-center justify-between gap-4 py-4 hover:bg-stone-50"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={t.latestVersion.artwork.contentUrl}
                      alt=""
                      className="h-14 w-auto rounded-sm ring-1 ring-stone-200"
                    />
                    <div className="min-w-0">
                      <p className="font-medium wrap-anywhere">
                        {t.name}
                        {t.archivedAt && (
                          <span className="ml-2 rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700">
                            archived
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-stone-500">
                        Current: v{t.latestVersion.versionNumber} ·{' '}
                        {formatMm(t.latestVersion.widthMm)} × {formatMm(t.latestVersion.heightMm)} ·{' '}
                        {t.versionCount} version{t.versionCount === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>
                  <span className="text-sm text-stone-400">{formatDateTime(t.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
