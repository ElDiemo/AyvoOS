import { financeSupplierSchema } from '@ayvo/types';
import { z } from 'zod';
import { FinanceHeader } from '@/components/finance/finance-header';
import { ReceiveDocumentForm } from '@/components/finance/receive-document-form';
import { Card } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Nahrát doklad (doc 039, N1; UI-02): receiving a PDF original with its metadata, on its own page
 * of the module (finance:documents_manage) — the same form and API as before; after receiving it
 * opens the document.
 */
export default async function ReceiveFinanceDocumentPage() {
  await requirePermission('finance:documents_manage');
  const suppliers = await apiGet('admin/finance/suppliers', z.array(financeSupplierSchema));
  return (
    <>
      <FinanceHeader
        active="documents"
        title={t.receive.title}
        back={{ href: '/finance/documents', label: t.list.back }}
      />
      <Card testId="finance-receive">
        <ReceiveDocumentForm suppliers={suppliers} />
      </Card>
    </>
  );
}
