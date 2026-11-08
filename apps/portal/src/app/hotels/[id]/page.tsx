import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalRefusal } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { myHotel, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

export default async function HotelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { token, view } = await portalSession();
  const hotel = await myHotel(token, id).catch((e: unknown) => {
    // Another hotel (or none): not found, exactly like a missing one.
    if (e instanceof PortalRefusal && e.status === 404) notFound();
    throw e;
  });
  return (
    <Shell user={view.user} active="hotels" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <Link href="/" className="text-sm underline">
        {cs.hotels.back}
      </Link>
      <h1 className="text-xl font-semibold" data-testid="portal-hotel-name">
        {hotel.name}
      </h1>
      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-stone-500">{cs.hotels.address}</dt>
        <dd>
          {hotel.addressLine1}
          {hotel.addressLine2 ? `, ${hotel.addressLine2}` : ''}, {hotel.postalCode} {hotel.city},{' '}
          {hotel.countryCode}
        </dd>
      </dl>
    </Shell>
  );
}
