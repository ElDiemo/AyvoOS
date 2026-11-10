import { returnReceiptCodeSchema, returnReceiptDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { ReceiptWorkspace } from '@/components/returns/receipt-workspace';
import { CycleHeader } from '@/components/returns/cycle-header';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** One return receipt (doc 047 §4.9): crates and boxes, bottle by bottle, Vyprázdněno, issues. */
export default async function ReturnReceiptPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!returnReceiptCodeSchema.safeParse(code).success) notFound();
  const me = await requirePermission('returns:receive');
  const receipt = await apiGet(`admin/returns/receipts/${code}`, returnReceiptDetailSchema);
  return (
    <>
      <CycleHeader
        active="returns"
        title={`${returnsCs.title} ${receipt.code}`}
        subtitle={receipt.hotelName ?? undefined}
        back={{ href: '/production/cycle/returns', label: returnsCs.receipt.back }}
      />
      <ReceiptWorkspace
        key={receipt.code}
        initial={receipt}
        canCorrect={hasPermission(me, 'returns:correct')}
      />
    </>
  );
}
