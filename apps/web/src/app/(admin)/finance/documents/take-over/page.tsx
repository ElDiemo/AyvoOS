import { takeOverCandidateSchema } from '@ayvo/types';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { FinanceHeader } from '@/components/finance/finance-header';
import { TakeOverList } from '@/components/finance/take-over-list';
import { Card } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Převzít ze skladu (doc 039, N1; UI-02): supplier documents of Sklad to take over, on their own
 * page of the module (finance:documents_manage + procurement:documents_read; the core decides which
 * sites' paperwork the user sees) — the same list and API as before.
 */
export default async function TakeOverFinanceDocumentsPage() {
  const me = await requirePermission('finance:documents_manage');
  if (!hasPermission(me, 'procurement:documents_read')) redirect('/forbidden');
  const candidates = await apiGet(
    'admin/finance/supplier-documents',
    z.array(takeOverCandidateSchema),
  );
  return (
    <>
      <FinanceHeader
        active="documents"
        title={t.takeOver.title}
        back={{ href: '/finance/documents', label: t.list.back }}
      />
      <Card testId="finance-take-over">
        <TakeOverList candidates={candidates} />
      </Card>
    </>
  );
}
