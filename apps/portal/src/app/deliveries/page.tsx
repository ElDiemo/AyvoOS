import type { Metadata } from 'next';
import { pragueToday } from '@/components/delivery-summary';
import { HotelDeliveriesList } from '@/components/hotel-deliveries-list';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { perHotel } from '@/lib/per-hotel';
import { myDeliveries, myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dodávky' };

/**
 * "Dodávky" (owner 2026-11-11, hotel-first): the account's hotels, one short line each — the next
 * real order, the next plan day without an order — and the way to that hotel's deliveries. Never
 * a feed of every order of every hotel. Each hotel through the same contract (the grant checked
 * each time); one unavailable says so in its own line only.
 */
export default async function AllDeliveriesPage() {
  const { token, view } = await portalSession();
  const hotels = await myHotels(token);
  const deliveries = await perHotel(
    hotels.map((h) => h.id),
    (id) => myDeliveries(token, id),
  );
  const t = cs.allDeliveries;
  return (
    <Shell user={view.user} active="deliveries" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-stone-900">{t.title}</h1>
        <p className="text-sm text-stone-600">{t.intro}</p>
      </div>
      {hotels.length === 0 ? (
        <p className="text-sm text-stone-600">{cs.hotels.none}</p>
      ) : (
        <HotelDeliveriesList hotels={hotels} deliveries={deliveries} today={pragueToday()} />
      )}
    </Shell>
  );
}
