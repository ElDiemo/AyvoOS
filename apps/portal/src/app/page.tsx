import Link from 'next/link';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

/** "Moje hotely": the hotels of the session's active grants, read only. */
export default async function HotelsPage() {
  const { token, view } = await portalSession();
  const hotels = await myHotels(token);
  return (
    <Shell user={view.user} active="hotels" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <h1 className="text-xl font-semibold">{cs.hotels.title}</h1>
      {hotels.length === 0 ? (
        <p className="text-sm text-stone-600">{cs.hotels.none}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="portal-hotels">
          {hotels.map((h) => (
            <li key={h.id} className="rounded-md border border-stone-200 bg-white p-3">
              <Link href={`/hotels/${h.id}`} className="font-medium underline">
                {h.name}
              </Link>
              <p className="text-sm text-stone-600">
                {h.addressLine1}, {h.postalCode} {h.city}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
