import { hotelCodeSchema, hotelDetailSchema, hotelOrdersSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrderRows } from '@/components/dispatch/order-rows';
import { Pager } from '@/components/dispatch/pager';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { buttonClass, Card, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { hotelsCs } from '@/i18n/cs/hotels';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = hotelsCs.detail;

/**
 * Hotel detail (doc 028): delivery address, contact, serving site and — with orders:read — its
 * orders at the active site (orders of other sites stay there, doc 022).
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
  const [orders, timeZone] = await Promise.all([
    canSeeOrders
      ? apiGet(`admin/orders/hotel/${code}`, hotelOrdersSchema, { page, pageSize: 50 })
      : Promise.resolve(null),
    siteTimeZone(),
  ]);
  const a = hotel.address;
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
      <div className="mb-6 grid gap-6 md:grid-cols-3">
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
        <Card title={t.site} testId="hotel-site">
          <p className="text-sm">
            {hotel.fulfillmentSite.name} ({hotel.fulfillmentSite.code})
          </p>
          <p className="mt-2 text-xs text-stone-500">{hotelsCs.form.siteHelp}</p>
        </Card>
      </div>
      {hasPermission(me, 'orders:read') && (
        <Card title={t.orders} testId="hotel-orders">
          {!servedHere ? (
            <Notice tone="info">{t.otherSite(hotel.fulfillmentSite.name)}</Notice>
          ) : orders && orders.total > 0 ? (
            <>
              <OrderRows orders={orders.items} hotel={false} />
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
      )}
    </>
  );
}
