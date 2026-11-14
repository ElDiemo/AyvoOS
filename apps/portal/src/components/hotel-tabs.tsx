import Link from 'next/link';
import { cs } from '@/i18n/cs';

/** The hotel's own sections: its profile and its deliveries. */
export function HotelTabs({
  hotelId,
  active,
}: {
  hotelId: string;
  active: 'profile' | 'deliveries';
}) {
  const tab = (key: 'profile' | 'deliveries', href: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={`rounded-full px-4 py-1.5 text-sm font-medium ${
        active === key
          ? 'bg-emerald-950 text-stone-50'
          : 'border border-stone-300 bg-white text-stone-700 hover:border-emerald-800'
      }`}
    >
      {cs.hotelTabs[key]}
    </Link>
  );
  return (
    <nav aria-label={cs.hotelTabs.label} className="flex flex-wrap gap-2">
      {tab('profile', `/hotels/${hotelId}`)}
      {tab('deliveries', `/hotels/${hotelId}/deliveries`)}
    </nav>
  );
}
