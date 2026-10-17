import { hotelSummarySchema, orderableProductSchema } from '@ayvo/types';
import { z } from 'zod';
import { DispatchHeader } from '@/components/dispatch/dispatch-header';
import { OrderForm } from '@/components/dispatch/order-form';
import { Notice } from '@/components/ui';
import { ordersCs as t } from '@/i18n/cs/orders';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Nová objednávka (orders:manage): a hotel served by the active site, whole crates per product. */
export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ hotel?: string }>;
}) {
  await requirePermission('orders:manage');
  const { hotel } = await searchParams;
  const [hotels, products] = await Promise.all([
    apiGet('admin/orders/hotels', z.array(hotelSummarySchema)),
    apiGet('admin/orders/products', z.array(orderableProductSchema)),
  ]);
  return (
    <>
      <DispatchHeader
        active="new"
        title={t.form.title}
        subtitle={t.form.subtitle}
        back={{ href: '/dispatch', label: t.title }}
      />
      {hotels.length === 0 && <Notice tone="warning">{t.form.noHotels}</Notice>}
      {products.length === 0 && <Notice tone="warning">{t.form.noProducts}</Notice>}
      <OrderForm
        hotels={hotels}
        products={products}
        initialHotel={hotels.some((h) => h.code === hotel) ? hotel! : ''}
      />
    </>
  );
}
