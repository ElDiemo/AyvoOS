import { orderCodeSchema, orderDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { PickingWorkspace } from '@/components/dispatch/picking-workspace';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Kompletace (orders:pick): the scan screen for a mobile terminal (doc 028 §5). */
export default async function PickPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!orderCodeSchema.safeParse(code).success) notFound();
  await requirePermission('orders:pick');
  const order = await apiGet(`admin/orders/${code}`, orderDetailSchema);
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PickingWorkspace key={order.code} initial={order} />
    </div>
  );
}
