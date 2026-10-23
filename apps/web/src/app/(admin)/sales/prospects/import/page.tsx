import { importSummarySchema, salespersonSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { ImportWizard } from '@/components/sales/import-wizard';
import { salesDateTime } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.importer;

/** Import zájemců z CSV (doc 034 §13) and the user's recent imports. */
export default async function ImportPage() {
  const me = await requirePermission('sales:work');
  const [salespeople, recent] = await Promise.all([
    hasPermission(me, 'sales:manage')
      ? apiGet('admin/sales/salespeople', z.array(salespersonSchema))
      : null,
    apiGet('admin/sales/imports', z.array(importSummarySchema)),
  ]);
  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.title}
        subtitle={t.subtitle}
        back={{ href: '/sales/prospects', label: salesCs.list.title }}
      />
      <div className="flex flex-col gap-6">
        <ImportWizard salespeople={salespeople} />
        <Card title={t.recent} testId="import-recent">
          {recent.length === 0 ? (
            <EmptyState>{t.recentEmpty}</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-stone-100 text-sm">
              {recent.map((r) => (
                <li key={r.code} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
                  <Link
                    href={`/sales/prospects/import/${r.code}`}
                    className="font-medium underline-offset-2 hover:underline wrap-anywhere"
                  >
                    {r.code} · {r.fileName}
                  </Link>
                  <span className="text-stone-500">
                    {salesDateTime(r.createdAt)} · {r.createdBy} → {r.owner} ·{' '}
                    {t.recentRow(r.createdCount, r.rowCount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
