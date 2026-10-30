import {
  hotelCodeSchema,
  hotelDeliveriesSchema,
  hotelDetailSchema,
  hotelOrdersSchema,
  orderCalendarSchema,
  supplyPlanResponseSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrderRows } from '@/components/dispatch/order-rows';
import { Pager } from '@/components/dispatch/pager';
import { DeliveriesOverview } from '@/components/hotels/deliveries-overview';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { PracticalDetails } from '@/components/hotels/practical-details';
import { SupplyPlanSummary } from '@/components/hotels/supply-plan-summary';
import { buttonClass, Card, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { hotelsCs } from '@/i18n/cs/hotels';
import { supplyPlansCs } from '@/i18n/cs/supply-plans';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';
import { HotelBillingPanel } from '@/components/hotels/hotel-billing-panel';

export const dynamic = 'force-dynamic';
const t = hotelsCs.detail;

/**
 * Hotel detail (doc 028, doc 032), in clear sections: details (address, contacts, receiving of
 * goods, serving site), the supply plan, orders and deliveries. The plan, orders and deliveries
 * belong to the serving site and are shown at it (doc 022) with orders:read.
 */
export default async function HotelPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { code } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  if (!hotelCodeSchema.safeParse(code).success) notFound();
  const me = await currentUser();
  const hotel = await apiGet(`admin/hotels/${code}`, hotelDetailSchema);
  const active = me.sites.find((s) => s.id === me.activeSiteId) ?? null;
  const servedHere = active?.code === hotel.fulfillmentSite.code;
  const canSeeOrders = hasPermission(me, 'orders:read') && servedHere;
  const [orders, plan, deliveries, calendar, timeZone] = await Promise.all([
    canSeeOrders
      ? apiGet(`admin/orders/hotel/${code}`, hotelOrdersSchema, { page, pageSize: 50 })
      : Promise.resolve(null),
    canSeeOrders
      ? apiGet(`admin/orders/hotel/${code}/supply-plan`, supplyPlanResponseSchema)
      : Promise.resolve(null),
    canSeeOrders
      ? apiGet(`admin/orders/hotel/${code}/deliveries`, hotelDeliveriesSchema)
      : Promise.resolve(null),
    canSeeOrders ? apiGet('admin/orders/calendar', orderCalendarSchema) : Promise.resolve(null),
    siteTimeZone(),
  ]);
  const a = hotel.address;
  const canBilling = hasPermission(me, 'finance:billing_read');
  const canInvoices = hasPermission(me, 'finance:invoices_read');
  const sections = [
    { href: '#udaje', label: t.sectionDetails },
    ...(canBilling || canInvoices ? [{ href: '#fakturace', label: t.sectionBilling }] : []),
    ...(canSeeOrders
      ? [
          { href: '#plan', label: t.sectionPlan },
          { href: '#objednavky', label: t.sectionOrders },
          { href: '#dodavky', label: t.sectionDeliveries },
        ]
      : []),
  ];
  return (
    <>
      <HotelsHeader
        active="list"
        title={hotel.name}
        subtitle={`${hotel.code} · ${t.created(hotel.createdBy)} · ${formatDateTimeCs(hotel.createdAt, timeZone)}`}
        back={{ href: '/hotels', label: hotelsCs.title }}
        actions={
          servedHere &&
          hasPermission(me, 'orders:manage') && (
            <Link href={`/dispatch/orders/new?hotel=${hotel.code}`} className={buttonClass.primary}>
              {t.newOrder}
            </Link>
          )
        }
      />
      <nav
        aria-label={t.sections}
        className="mb-6 flex flex-wrap gap-2 text-sm"
        data-testid="hotel-sections"
      >
        {sections.map((s) => (
          <a key={s.href} href={s.href} className={buttonClass.secondary}>
            {s.label}
          </a>
        ))}
      </nav>
      <section
        id="udaje"
        className="mb-6 grid scroll-mt-4 gap-6 md:grid-cols-2"
        aria-label={t.sectionDetails}
      >
        <Card title={t.address} testId="hotel-address">
          <p className="text-sm">
            {a.addressLine1}
            {a.addressLine2 && (
              <>
                <br />
                {a.addressLine2}
              </>
            )}
            <br />
            {a.postalCode} {a.city}
            <br />
            {a.countryCode}
          </p>
        </Card>
        <Card title={t.contact} testId="hotel-contact">
          <FieldList>
            <Field label={hotelsCs.form.contactName}>{hotel.contact.name}</Field>
            <Field label={hotelsCs.form.contactPhone}>{hotel.contact.phone}</Field>
            <Field label={hotelsCs.form.contactEmail}>{hotel.contact.email}</Field>
          </FieldList>
        </Card>
        <Card title={t.practical} testId="hotel-practical-card">
          <PracticalDetails
            hotel={hotel.code}
            practical={hotel.practical}
            canEdit={hasPermission(me, 'hotels:manage')}
          />
        </Card>
        <Card title={t.site} testId="hotel-site">
          <p className="text-sm">
            {hotel.fulfillmentSite.name} ({hotel.fulfillmentSite.code})
          </p>
          <p className="mt-2 text-xs text-stone-500">{hotelsCs.form.siteHelp}</p>
        </Card>
      </section>
      {hasPermission(me, 'orders:read') && !servedHere && (
        <div className="mb-6" data-testid="hotel-orders">
          <Notice tone="info">{t.otherSite(hotel.fulfillmentSite.name)}</Notice>
        </div>
      )}
      {(canBilling || canInvoices) && (
        // Bounded (2 s per call, doc 044 U2): a slow or stopped Finance only costs this panel.
        <div className="mb-6 scroll-mt-4" id="fakturace">
          <HotelBillingPanel
            hotelId={hotel.id}
            canBilling={canBilling}
            canInvoices={canInvoices}
            canManage={hasPermission(me, 'finance:billing_manage')}
          />
        </div>
      )}
      {canSeeOrders && (
        <>
          <section id="plan" className="mb-6 scroll-mt-4" aria-label={t.sectionPlan}>
            <Card title={supplyPlansCs.title} testId="hotel-plan">
              <SupplyPlanSummary
                hotel={hotel.code}
                plan={plan?.plan ?? null}
                canManage={hasPermission(me, 'orders:plan_manage')}
                timeZone={timeZone}
              />
            </Card>
          </section>
          <section id="objednavky" className="mb-6 scroll-mt-4" aria-label={t.sectionOrders}>
            <Card title={t.orders} testId="hotel-orders">
              {orders && orders.total > 0 ? (
                <>
                  <OrderRows orders={orders.items} hotel={false} today={calendar?.today} />
                  <Pager
                    page={orders.page}
                    pageSize={orders.pageSize}
                    total={orders.total}
                    href={(p) => `/hotels/${hotel.code}?page=${p}`}
                  />
                </>
              ) : (
                <EmptyState>{t.noOrders}</EmptyState>
              )}
            </Card>
          </section>
          <section id="dodavky" className="scroll-mt-4" aria-label={t.sectionDeliveries}>
            <Card title={hotelsCs.deliveries.title} testId="hotel-deliveries">
              {deliveries && <DeliveriesOverview data={deliveries} />}
            </Card>
          </section>
        </>
      )}
    </>
  );
}
