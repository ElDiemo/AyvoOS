import { orderCodeSchema, orderDetailSchema, orderShipmentSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { PickingWorkspace } from '@/components/dispatch/picking-workspace';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Kompletace (orders:pick): the scan screen for a mobile terminal (doc 028 §5). */
export default async function PickPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!orderCodeSchema.safeParse(code).success) notFound();
  await requirePermission('orders:pick');
  const [order, me] = await Promise.all([
    apiGet(`admin/orders/${code}`, orderDetailSchema),
    currentUser(),
  ]);
  // "Dokončit a vytisknout štítky" only for those who may also prepare the shipment, at a site
  // with a carrier; printing only with printing:print on an enabled automatic dispatch printer.
  const dispatch =
    hasPermission(me, 'shipments:prepare') && hasPermission(me, 'shipments:read')
      ? await apiGet(`admin/orders/${code}/shipment`, orderShipmentSchema)
      : null;
  const combined = dispatch?.carrier.configured
    ? {
        printer:
          dispatch.printer?.autoPrint && hasPermission(me, 'printing:print')
            ? dispatch.printer
            : null,
      }
    : null;
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PickingWorkspace key={order.code} initial={order} combined={combined} />
    </div>
  );
}
