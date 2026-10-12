import { labelTemplateSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { ProductionHeader } from '@/components/production/production-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';
import { formatMm } from '@/lib/format';

const t = productionCs.templates;

export const dynamic = 'force-dynamic';

export default async function LabelTemplatesPage() {
  const [templates, me] = await Promise.all([
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
    currentUser(),
  ]);
  // Templates are company-wide brand data: changed only with the global permission.
  const canManage = hasPermission(me, 'production:templates_manage');
  return (
    <>
      <ProductionHeader
        active="templates"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <>
            <a
              href="/api/admin/label-calibration/qr-validation-sheet.pdf"
              className={buttonClass.secondary}
              download
            >
              {t.qrSheet}
            </a>
            {canManage && (
              <Link href="/label-templates/new" className={buttonClass.primary}>
                {t.create}
              </Link>
            )}
          </>
        }
      />
      <Card>
        {templates.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100">
            {templates.map((tpl) => (
              <li key={tpl.id}>
                <Link
                  href={`/label-templates/${tpl.id}`}
                  className="flex items-center justify-between gap-4 py-4 hover:bg-stone-50"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={tpl.latestVersion.artwork.contentUrl}
                      alt=""
                      className="h-14 w-auto rounded-sm ring-1 ring-stone-200"
                    />
                    <div className="min-w-0">
                      <p className="font-medium wrap-anywhere">
                        {tpl.name}
                        {tpl.archivedAt && (
                          <span className="ml-2 rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700">
                            {t.archived}
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-stone-500">
                        {t.summary(
                          tpl.latestVersion.versionNumber,
                          `${formatMm(tpl.latestVersion.widthMm)} × ${formatMm(tpl.latestVersion.heightMm)}`,
                          tpl.versionCount,
                        )}
                      </p>
                    </div>
                  </div>
                  <span className="hidden shrink-0 text-sm text-stone-400 sm:inline">
                    {formatDateTimeCs(tpl.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
