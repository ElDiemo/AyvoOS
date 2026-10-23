import { importCodeSchema, importResultSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { salesDateTime } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { buttonClass, Card, EmptyState, Notice } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const t = salesCs.importer;

/**
 * The result of a confirmed import (doc 034 §13), found again after a reload: what was created
 * and which rows were left out, by row number. Only its importer (or sales:manage) sees it.
 */
export default async function ImportResultPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!importCodeSchema.safeParse(code).success) notFound();
  const r = await apiGet(`admin/sales/imports/${code}`, importResultSchema);
  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.resultTitle(r.code)}
        subtitle={`${r.fileName} · ${salesDateTime(r.createdAt)} · ${r.createdBy}`}
        back={{ href: '/sales/prospects/import', label: t.title }}
      />
      <div className="flex flex-col gap-6">
        <p className="text-sm font-medium" data-testid="import-result-summary">
          {t.resultSummary(r.createdCount, r.rowCount, r.owner.name)}
        </p>
        {r.createdNotVisible > 0 && (
          <Notice tone="info">{t.notVisible(r.createdNotVisible)}</Notice>
        )}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title={`${t.created} (${r.created.length})`} testId="import-created">
            <ul className="flex flex-col divide-y divide-stone-100 text-sm">
              {r.created.map((c) => (
                <li key={c.code} className="flex gap-3 py-2">
                  <span className="w-16 shrink-0 text-stone-500">{t.row(c.row)}</span>
                  <Link
                    href={`/sales/prospects/${c.code}`}
                    className="min-w-0 font-medium underline-offset-2 hover:underline wrap-anywhere"
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={`${t.skipped} (${r.skipped.length})`} testId="import-skipped">
            {r.skipped.length === 0 ? (
              <EmptyState>{t.skippedNone}</EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-stone-100 text-sm">
                {r.skipped.map((s) => (
                  <li key={s.row} className="flex gap-3 py-2">
                    <span className="w-16 shrink-0 text-stone-500">{t.row(s.row)}</span>
                    <span className="min-w-0 wrap-anywhere">
                      {s.errors.length
                        ? s.errors
                            .map((e) => t.rowErrors[e as keyof typeof t.rowErrors] ?? e)
                            .join(' ')
                        : t.skippedByChoice}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/sales/prospects" className={buttonClass.primary}>
            {t.toList}
          </Link>
          <Link href="/sales/prospects/import" className={buttonClass.secondary}>
            {t.newImport}
          </Link>
        </div>
      </div>
    </>
  );
}
