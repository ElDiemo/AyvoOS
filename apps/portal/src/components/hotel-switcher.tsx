import type { PortalSessionView } from '@ayvo/types';
import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { myHotels } from '@/lib/portal';

/**
 * Switching between the account's hotels on a hotel's page (#169 P0 1). Shown only when the
 * session's grants cover more than one hotel — a one-hotel account makes no extra call. The list
 * comes from the core's "Moje hotely" (the grants evaluated now); when it cannot be read, nothing
 * is shown and the page works on.
 */
export async function HotelSwitcher({
  token,
  view,
  current,
  section,
}: {
  token: string;
  view: PortalSessionView;
  current: string;
  section: 'profile' | 'deliveries';
}) {
  const granted = new Set(view.grants.flatMap((g) => g.hotelIds));
  if (granted.size < 2) return null;
  const hotels = await myHotels(token).catch(() => null);
  if (!hotels || hotels.length < 2) return null;
  const suffix = section === 'deliveries' ? '/deliveries' : '';
  return (
    <nav
      aria-label={cs.switcher.label}
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="hotel-switcher"
    >
      <span className="text-stone-500">{cs.switcher.label}:</span>
      {hotels.map((h) =>
        h.id === current ? (
          <span
            key={h.id}
            aria-current="page"
            className="rounded-full bg-stone-200 px-3 py-1 font-medium text-stone-900"
          >
            {h.name}
          </span>
        ) : (
          <Link
            key={h.id}
            href={`/hotels/${h.id}${suffix}`}
            className="rounded-full border border-stone-300 bg-white px-3 py-1 text-stone-700 hover:border-emerald-800"
          >
            {h.name}
          </Link>
        ),
      )}
    </nav>
  );
}
