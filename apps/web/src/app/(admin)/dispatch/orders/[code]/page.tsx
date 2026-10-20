import {
  orderCalendarSchema,
  orderCodeSchema,
  orderDetailSchema,
  orderShipmentSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelOrder } from '@/components/dispatch/cancel-order';
import { DispatchHeader } from '@/components/dispatch/dispatch-header';
import { OrderLines } from '@/components/dispatch/order-lines';
import { OriginBadge } from '@/components/dispatch/order-origin';
import { RescheduleOrder } from '@/components/dispatch/reschedule-order';
import { OrderStatusBadge } from '@/components/dispatch/order-status';
import { ShipmentPanel } from '@/components/dispatch/shipment-panel';
import { buttonClass, Card, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { ordersCs } from '@/i18n/cs/orders';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = ordersCs.detail;

/**
 * Order detail (doc 028, doc 029): snapshot, requested vs. loaded per product, crates, the one
 * next step of the dispatch with its parcels and labels, and the history.
 */
export default async function OrderPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!orderCodeSchema.safeParse(code).success) notFound();
  const [me, order, timeZone, calendar] = await Promise.all([
    currentUser(),
    apiGet(`admin/orders/${code}`, orderDetailSchema),
    siteTimeZone(),
    apiGet('admin/orders/calendar', orderCalendarSchema),
  ]);
  const before = ['OPEN', 'READY_TO_DISPATCH', 'READY_FOR_PICKUP'].includes(order.status);
  const future = before && order.requestedShipDate > calendar.today;
  const shipment =
    order.status !== 'OPEN' && order.status !== 'CANCELLED' && hasPermission(me, 'shipments:read')
      ? await apiGet(`admin/orders/${code}/shipment`, orderShipmentSchema)
      : null;
  // A shipment at the carrier is cancelled first, never silently (known from orders:read too).
  const atCarrier = ['REQUESTING', 'LABELED', 'CANCELLING'].includes(order.shipment?.status ?? '');
  const cancellable =
    order.status === 'OPEN' || (order.status === 'READY_TO_DISPATCH' && !atCarrier);
  const d = order.delivery;
  return (
    <>
      <DispatchHeader
        active="orders"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{order.code}</span> <OrderStatusBadge order={order} />
            <OriginBadge origin={order.origin} />
          </span>
        }
        subtitle={`${order.hotel.name} · ${t.shipDate}: ${formatDateCs(order.requestedShipDate)}`}
        back={{ href: '/dispatch', label: ordersCs.title }}
        actions={
          <>
            {order.status === 'OPEN' && hasPermission(me, 'orders:pick') && (
              <Link
                href={`/dispatch/orders/${order.code}/pick`}
                className={buttonClass.primary}
                data-testid="start-picking"
              >
                {order.totals.loadedCrates > 0 ? t.resume : t.pick}
              </Link>
            )}
            {before && hasPermission(me, 'orders:manage') && (
              <RescheduleOrder
                code={order.code}
                current={order.requestedShipDate}
                today={calendar.today}
              />
            )}
            {cancellable && hasPermission(me, 'orders:manage') && <CancelOrder code={order.code} />}
          </>
        }
      />
      {order.origin === 'SUPPLY_PLAN' && order.plannedShipDate && (
        <p className="mb-2 text-sm text-stone-600" data-testid="order-from-plan">
          {t.fromPlan(formatDateCs(order.plannedShipDate))}
          {' · '}
          <Link href={`/hotels/${order.hotel.code}#plan`} className="underline underline-offset-2">
            {ordersCs.origin.SUPPLY_PLAN}
          </Link>
        </p>
      )}
      {future && order.status !== 'OPEN' && (
        <div className="mb-4">
          <Notice tone="info">
            <span data-testid="order-future">
              {t.futureReady(formatDateCs(order.requestedShipDate))}
            </span>
          </Notice>
        </div>
      )}
      {order.completedBy && order.status !== 'CANCELLED' && (
        <p className="mb-4 text-sm text-stone-600" data-testid="order-completed">
          {t.completed(order.completedBy)} · {formatDateTimeCs(order.completedAt, timeZone)}
        </p>
      )}
      {shipment && (
        <ShipmentPanel
          code={order.code}
          status={order.status}
          data={shipment}
          canPrepare={hasPermission(me, 'shipments:prepare')}
          canHandOver={hasPermission(me, 'shipments:handover')}
          canResolveUncertain={hasPermission(me, 'shipments:resolve_uncertain')}
          canPrint={hasPermission(me, 'printing:print')}
          canReprint={hasPermission(me, 'printing:reprint')}
          timeZone={timeZone}
        />
      )}
      {order.status === 'CANCELLED' && order.cancelledBy && order.cancelReason && (
        <div className="mb-6">
          <Notice tone="warning">
            {t.cancelled(order.cancelledBy, order.cancelReason)} ·{' '}
            {formatDateTimeCs(order.cancelledAt, timeZone)}
          </Notice>
        </div>
      )}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title={t.lines} className="lg:col-span-2" testId="order-lines">
          <OrderLines order={order} />
        </Card>
        <Card title={t.delivery} testId="order-delivery">
          <p className="text-sm">
            <span className="font-medium">{d.hotelName}</span>
            <br />
            {d.addressLine1}
            {d.addressLine2 && (
              <>
                <br />
                {d.addressLine2}
              </>
            )}
            <br />
            {d.postalCode} {d.city}, {d.countryCode}
          </p>
          <div className="mt-4">
            <FieldList>
              <Field label={t.contact}>
                {order.contact.name}, {order.contact.phone}, {order.contact.email}
              </Field>
              <Field label={t.site}>
                {order.site.name} ({order.site.code})
              </Field>
            </FieldList>
          </div>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t.crates} testId="order-crates">
          {order.crates.length === 0 ? (
            <EmptyState>{t.noCrates}</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {order.crates.map((c) => (
                <li
                  key={c.crate}
                  data-testid={`order-crate-${c.crate}`}
                  className="flex flex-wrap gap-x-3"
                >
                  <Link
                    href={`/production/crates/${c.crate}`}
                    className="font-mono font-medium underline-offset-2 hover:underline"
                  >
                    {c.crate}
                  </Link>
                  <span>
                    {c.product.name} · {c.bottles} ks · {t.recipe(c.recipeVersion)}
                  </span>
                  <span className="text-stone-500">
                    {t.loadedBy(c.loadedBy)}, {formatDateTimeCs(c.loadedAt, timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t.history} testId="order-history">
          <ol className="flex flex-col gap-2 text-sm">
            {order.history.map((e, i) => (
              <li key={i}>
                <span className="font-medium">
                  {(e.source === 'CARRIER' ? t.carrierEvents[e.type] : undefined) ??
                    t.events[e.type] ??
                    e.type}
                </span>
                {e.type === 'CREATED' && order.origin === 'SUPPLY_PLAN' && (
                  <span> · {ordersCs.origin.SUPPLY_PLAN}</span>
                )}
                {e.shipDateFrom && e.shipDateTo && (
                  <span>
                    {' '}
                    · {formatDateCs(e.shipDateFrom)} → {formatDateCs(e.shipDateTo)}
                  </span>
                )}
                {e.shipment && <span className="font-mono"> · {e.shipment}</span>}
                {e.parcels !== null && <span> · {t.parcels(e.parcels)}</span>}
                {e.crate && <span className="font-mono"> · {e.crate}</span>}
                {e.reason && <span> · {e.reason}</span>}
                <span className="block text-xs text-stone-500">
                  {e.actor ?? t.byCarrier} · {formatDateTimeCs(e.occurredAt, timeZone)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
