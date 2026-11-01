import { Card } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { requireAnyPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.versionMismatch;

/**
 * A web newer than the running Finance (doc 040 §12a): this pair is not supported. Says so instead
 * of "temporarily unavailable"; reads nothing from Finance, changes nothing.
 */
export default async function FinanceVersionMismatchPage() {
  await requireAnyPermission(['finance:invoices_read', 'finance:billing_read']);
  return (
    <Card testId="finance-version-mismatch">
      <h1 className="text-lg font-semibold">{t.title}</h1>
      <p className="mt-2 text-sm text-stone-600">{t.text}</p>
      <p className="mt-2 text-sm text-stone-600">{t.action}</p>
    </Card>
  );
}
