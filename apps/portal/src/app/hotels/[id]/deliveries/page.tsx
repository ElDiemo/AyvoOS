import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pragueToday } from '@/components/delivery-summary';
import { HotelDeliveryDetail } from '@/components/hotel-delivery-detail';
import { HotelSwitcher } from '@/components/hotel-switcher';
import { HotelTabs } from '@/components/hotel-tabs';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalRefusal, PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { myDeliveries, myHotelProfile, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dodávky hotelu' };

/** One hotel's deliveries (owner 2026-11-11, hotel-first); another hotel's id is "not found". */
export default async function DeliveriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { token, view } = await portalSession();
  const [profile, deliveries] = await Promise.all([
    myHotelProfile(token, id).catch((e: unknown) => {
      if (e instanceof PortalRefusal && e.status === 404) notFound();
      throw e;
    }),
    myDeliveries(token, id).catch((e: unknown) => {
      if (e instanceof PortalUnavailable || e instanceof PortalRefusal) return null;
      throw e;
    }),
  ]);
  return (
    <Shell user={view.user} active="deliveries" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <Link
        href="/deliveries"
        className="w-fit text-sm text-stone-600 underline-offset-2 hover:underline"
      >
        <span aria-hidden="true">←</span> {cs.deliveries.back}
      </Link>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
          {cs.deliveries.eyebrow}
        </p>
        <h1 className="text-2xl font-semibold text-stone-900" data-testid="portal-hotel-name">
          {profile.name}
        </h1>
      </div>
      <HotelSwitcher token={token} view={view} current={id} section="deliveries" />
      <HotelTabs hotelId={id} active="deliveries" />
      {deliveries === null ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {cs.deliveries.unavailable}
        </p>
      ) : (
        <HotelDeliveryDetail deliveries={deliveries} today={pragueToday()} />
      )}
    </Shell>
  );
}
