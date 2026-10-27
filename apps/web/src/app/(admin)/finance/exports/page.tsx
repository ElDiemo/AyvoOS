import { accountingExportSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CreateExportForm } from '@/components/finance/create-export-form';
import { financeDate, financeMonth } from '@/components/finance/finance-format';
import { Card, EmptyState } from '@/components/ui';
import { FinanceHeader } from '@/components/finance/finance-header';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.exports;

/** The previous and the current calendar month ("YYYY-MM", Prague). */
function months(now = new Date()): [string, string] {
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number];
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  const pad = (n: number) => String(n).padStart(2, '0');
  return [`${prev[0]}-${pad(prev[1]!)}`, `${y}-${pad(m)}`];
}

/**
 * Export pro účetní (doc 039 §7, N2): create one handover month (finance:exports_manage) and the
 * history with what was handed over to the accountant (recorded by hand) and downloads.
 */
export default async function AccountingExportsPage() {
  const me = await requirePermission('finance:documents_read');
  const canCreate = hasPermission(me, 'finance:exports_manage');
  const exports = await apiGet('admin/finance/exports', z.array(accountingExportSchema));
  const [lastMonth, thisMonth] = months();
  return (
    <>
      <FinanceHeader active="exports" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {canCreate && (
          <Card title={t.create}>
            <CreateExportForm lastMonth={lastMonth} thisMonth={thisMonth} />
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
                    {financeMonth(e.handoverMonth)} · {t.modesShort[e.mode]} ·{' '}
                    {t.count(e.documentCount)}
                  </span>
                  <span className="text-xs text-stone-500">
                    {e.handedOverOn ? t.handedOver(financeDate(e.handedOverOn)) : t.notHandedOver} ·{' '}
                    {t.downloads(e.downloads)} · {e.createdBy}
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
