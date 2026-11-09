import Link from 'next/link';
import { HotelDispatch, pragueToday } from '@/components/home-overview';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { perHotel } from '@/lib/per-hotel';
import { myDeliveries, myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

/**
 * "Moje hotely": the hotels of the session's active grants, each leading to its profile, with
 * its dispatch at a glance (owner 2026-11-10).
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
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="portal-hotels">
          {hotels.map((h) => (
            <li key={h.id}>
              <Link
                href={`/hotels/${h.id}`}
                className="group flex h-full flex-col gap-2 rounded-xl border border-stone-200 bg-white p-5 shadow-sm transition-colors hover:border-emerald-800"
              >
                <span className="text-lg font-semibold text-stone-900">{h.name}</span>
                <span className="text-sm text-stone-600">
                  {h.addressLine1}, {h.postalCode} {h.city}
                </span>
                <HotelDispatch deliveries={deliveries.get(h.id) ?? null} today={today} />
                <span className="mt-auto pt-2 text-sm font-medium text-emerald-800 group-hover:underline">
                  {cs.hotels.open} <span aria-hidden="true">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
