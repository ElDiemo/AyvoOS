import { FinanceHeader } from '@/components/finance/finance-header';
import { TestRunForm } from '@/components/finance/test-run-form';
import { Card, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;

/** Měsíční běh (doc 040 §11): TEST invoices of a stated period from the agreements in effect. */
export default async function TestRunPage() {
  await requirePermission('finance:invoices_test');
  await requirePermission('finance:billing_read');
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={t.run.title}
        subtitle={t.run.subtitle}
        back={{ href: '/finance/invoices', label: t.back }}
      />
      <div className="flex flex-col gap-4">
        <Notice tone="warning">{t.testOnly}</Notice>
        <Card>
          <TestRunForm />
        </Card>
      </div>
    </>
  );
}
