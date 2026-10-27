import { invoiceSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { financeAmount, financeDate, financeMonth } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { buttonClass, Card, EmptyState, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;

/** Faktury (N3A-2b, doc 040 §9): the list; TEST invoices only (no live issuing exists). */
export default async function InvoicesPage() {
  const me = await requirePermission('finance:invoices_read');
  const canIssue = hasPermission(me, 'finance:invoices_test');
  const invoices = await apiGet('admin/finance/invoices', z.array(invoiceSummarySchema));
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          canIssue ? (
            <Link
              href="/finance/invoices/new"
              className={buttonClass.primary}
              data-testid="invoice-new"
            >
              {t.create}
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <Notice tone="warning">{t.testOnly}</Notice>
        <Card testId="invoices">
          {invoices.length === 0 ? (
            <EmptyState>{t.empty}</EmptyState>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {invoices.map((i) => (
                <li
                  key={i.number}
                  className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 ${
                    i.status === 'CANCELLED' ? 'text-stone-400' : ''
                  }`}
                >
                  <Link href={`/finance/invoices/${i.number}`} className="font-mono underline">
                    {i.number}
                  </Link>
                  <span className="min-w-0 flex-1">
                    {i.customer.legalName} · {financeMonth(i.period)} ·{' '}
                    {i.hotels.map((h) => h.name).join(', ')}
                  </span>
                  <span className="tabular-nums">{financeAmount(i.total, i.currency)}</span>
                  <span>
                    {t.dueOn} {financeDate(i.dueOn)}
                  </span>
                  <span className="font-medium">{t.status[i.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
