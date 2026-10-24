import { accountingExportSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CreateExportForm } from '@/components/finance/create-export-form';
import { financeDate } from '@/components/finance/finance-format';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.exports;

/** The previous calendar month (a sensible default period; any period up to 366 days). */
function previousMonth(now = new Date()): [string, string] {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

/** Export pro účetní (doc 039 §7, N2): create (finance:exports_manage) and the history. */
export default async function AccountingExportsPage() {
  const me = await currentUser();
  const canCreate = hasPermission(me, 'finance:exports_manage');
  const exports = await apiGet('admin/finance/exports', z.array(accountingExportSchema));
  const [from, to] = previousMonth();
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {canCreate && (
          <Card title={t.create}>
            <CreateExportForm defaultFrom={from} defaultTo={to} />
          </Card>
        )}
        <Card title={t.history} testId="export-history">
          {exports.length === 0 ? (
            <EmptyState>{t.empty}</EmptyState>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {exports.map((e) => (
                <li key={e.code} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <Link href={`/finance/exports/${e.code}`} className="font-mono underline">
                    {e.code}
                  </Link>
                  <span className="min-w-0 flex-1">
                    {financeDate(e.periodFrom)} – {financeDate(e.periodTo)} · {t.modesShort[e.mode]}
                  </span>
                  <span className="text-xs text-stone-500">
                    {t.count(e.documentCount)} · {e.createdBy}
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
