import type { Metadata } from 'next';
import { pragueToday } from '@/components/delivery-summary';
import { HotelCard } from '@/components/hotel-card';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { perHotel } from '@/lib/per-hotel';
import { myDeliveries, myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Moje hotely' };

/**
 * "Moje hotely": the hotels of the session's active grants, each with its current order and its
 * next plan day at a glance, and the ways to its deliveries and profile (owner 2026-11-11).
 */
export default async function HotelsPage() {
  const { token, view } = await portalSession();
  const hotels = await myHotels(token);
  const deliveries = await perHotel(
    hotels.map((h) => h.id),
    (id) => myDeliveries(token, id),
  );
  const today = pragueToday();
  return (
    <Shell user={view.user} active="hotels" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-stone-900">{cs.hotels.title}</h1>
        <p className="text-sm text-stone-600">{cs.hotels.intro}</p>
      </div>
      {hotels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-6">
          <p className="font-medium text-stone-800">{cs.hotels.none}</p>
          <p className="mt-1 text-sm text-stone-600">{cs.hotels.noneHelp}</p>
        </div>
      ) : (
        <ul
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="portal-hotels"
        >
          {hotels.map((h) => (
            <li key={h.id}>
              <HotelCard hotel={h} deliveries={deliveries.get(h.id) ?? null} today={today} />
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
