import { FinanceHeader } from '@/components/finance/finance-header';
import { TestInvoiceForm } from '@/components/finance/test-invoice-form';
import { Card, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;

/** The previous calendar month in Prague ("YYYY-MM"): the usual month to bill in arrears. */
function previousMonth(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number];
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** Vystavit testovací fakturu (N3A-2b): reads the billing settings, issues a TEST invoice only. */
export default async function NewTestInvoicePage() {
  await requirePermission('finance:invoices_test');
  await requirePermission('finance:billing_read');
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={t.newTitle}
        subtitle={t.newSubtitle}
        back={{ href: '/finance/invoices', label: t.back }}
      />
      <div className="flex flex-col gap-4">
        <Notice tone="warning">{t.testOnly}</Notice>
        <Card>
          <TestInvoiceForm month={previousMonth()} />
        </Card>
      </div>
    </>
  );
}
