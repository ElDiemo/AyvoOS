import { invoiceSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { FinanceHeader } from '@/components/finance/finance-header';
import { InvoiceList } from '@/components/finance/invoice-list';
import { buttonClass, Card, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;

/**
 * Faktury (N3A-2b, doc 040 §9; a view of Faktury hotelům, doc 042): the list; TEST invoices only
 * (no live issuing exists).
 */
export default async function InvoicesPage() {
  const me = await requirePermission('finance:invoices_read');
  const canIssue = hasPermission(me, 'finance:invoices_test');
  const invoices = await apiGet('admin/finance/invoices', z.array(invoiceSummarySchema));
  return (
    <>
      <FinanceHeader
        active="invoices"
        view="invoices"
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm text-stone-600">
              <span>{t.empty}</span>
              <Link href="/finance/billing" className="underline" data-testid="invoices-to-billing">
                {t.emptyToBilling}
              </Link>
            </div>
          ) : (
            <InvoiceList invoices={invoices} />
          )}
        </Card>
      </div>
    </>
  );
}
