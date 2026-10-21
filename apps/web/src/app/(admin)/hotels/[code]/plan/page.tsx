import {
  hotelCodeSchema,
  hotelDetailSchema,
  orderableProductSchema,
  orderCalendarSchema,
  supplyPlanResponseSchema,
} from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { SupplyPlanEditor } from '@/components/hotels/supply-plan-editor';
import { Notice } from '@/components/ui';
import { hotelsCs } from '@/i18n/cs/hotels';
import { supplyPlansCs } from '@/i18n/cs/supply-plans';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Plán zásobování of a hotel (doc 032), at the hotel's serving site: read with orders:read,
 * managed with orders:plan_manage (ADMIN only for now).
 */
export default async function SupplyPlanPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!hotelCodeSchema.safeParse(code).success) notFound();
  const me = await currentUser();
  if (!hasPermission(me, 'orders:read')) notFound();
  const hotel = await apiGet(`admin/hotels/${code}`, hotelDetailSchema);
  const active = me.sites.find((s) => s.id === me.activeSiteId) ?? null;
  const header = (
    <HotelsHeader
      active="list"
      title={supplyPlansCs.pageTitle(hotel.name)}
      subtitle={`${hotel.code} · ${hotel.fulfillmentSite.name}`}
      back={{ href: `/hotels/${hotel.code}#plan`, label: hotel.name }}
    />
  );
  if (active?.code !== hotel.fulfillmentSite.code) {
    return (
      <>
        {header}
        <Notice tone="info">{hotelsCs.detail.otherSite(hotel.fulfillmentSite.name)}</Notice>
      </>
    );
  }
  const canManage = hasPermission(me, 'orders:plan_manage');
  const [plan, calendar, products] = await Promise.all([
    apiGet(`admin/orders/hotel/${code}/supply-plan`, supplyPlanResponseSchema),
    apiGet('admin/orders/calendar', orderCalendarSchema),
    canManage && hasPermission(me, 'orders:manage')
      ? apiGet('admin/orders/products', z.array(orderableProductSchema))
      : Promise.resolve([]),
  ]);
  return (
    <>
      {header}
      <SupplyPlanEditor
        hotel={hotel.code}
        plan={plan.plan}
        products={products}
        today={calendar.today}
        canManage={canManage}
      />
    </>
  );
}
