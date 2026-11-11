import type { Metadata } from 'next';
import Link from 'next/link';
import { DeliveryGroups } from '@/components/deliveries';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { perHotel } from '@/lib/per-hotel';
import { myDeliveries, myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dodávky' };

/**
 * "Dodávky" of every hotel of the account (main navigation): per hotel the same groups as its own
 * "Dodávky" page, through the same contract (the grant checked each time). One hotel unavailable
 * says so in its own section only.
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
        hotels.map((h) => {
          const d = deliveries.get(h.id) ?? null;
          return (
            <section
              key={h.id}
              aria-labelledby={`deliveries-${h.id}`}
              className="flex flex-col gap-3"
              data-testid={`all-deliveries-${h.id}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id={`deliveries-${h.id}`} className="text-lg font-semibold text-stone-900">
                  {h.name}
                </h2>
                <Link
                  href={`/hotels/${h.id}`}
                  className="text-sm text-emerald-800 underline-offset-2 hover:underline"
                >
                  {t.hotel}
                </Link>
              </div>
              {d ? (
                <DeliveryGroups deliveries={d} idPrefix={`h-${h.id}-`} />
              ) : (
                <p className="text-sm text-amber-800">{t.unavailable}</p>
              )}
            </section>
          );
        })
      )}
    </Shell>
  );
}
