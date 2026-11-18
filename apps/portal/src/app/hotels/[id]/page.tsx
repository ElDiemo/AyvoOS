import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContractsCard } from '@/components/contracts-card';
import { NextDeliveryCard } from '@/components/deliveries';
import { pragueToday } from '@/components/delivery-summary';
import { HotelSwitcher } from '@/components/hotel-switcher';
import { HotelTabs } from '@/components/hotel-tabs';
import { HotelHero, ProfileGroups } from '@/components/profile-view';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalRefusal, PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { myContracts, myDeliveries, myHotelProfile, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Profil hotelu' };

/** "Profil hotelu": a granted hotel's own profile in three groups. */
export default async function HotelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { token, view } = await portalSession();
  const [profile, contracts, deliveries] = await Promise.all([
    myHotelProfile(token, id).catch((e: unknown) => {
      // Another hotel (or none): not found, exactly like a missing one.
      if (e instanceof PortalRefusal && e.status === 404) notFound();
      throw e;
    }),
    // The contracts never bring the profile down: unavailable → said so in their card.
    myContracts(token, id).catch((e: unknown) => {
      if (e instanceof PortalUnavailable || e instanceof PortalRefusal) return null;
      throw e;
    }),
    myDeliveries(token, id).catch((e: unknown) => {
      if (e instanceof PortalUnavailable || e instanceof PortalRefusal) return null;
      throw e;
    }),
  ]);
  const saved = (await searchParams).saved === '1';
  return (
    <Shell user={view.user} active="hotels" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <Link href="/" className="w-fit text-sm text-stone-600 underline-offset-2 hover:underline">
        <span aria-hidden="true">←</span> {cs.hotels.back}
      </Link>
      {saved && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {cs.profile.saved}
        </p>
      )}
      <HotelHero
        profile={profile}
        action={
          <Link
            href={`/hotels/${id}/edit`}
            className="rounded-lg bg-stone-50 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-white"
          >
            {cs.profile.edit}
          </Link>
        }
      />
      <HotelSwitcher token={token} view={view} current={id} section="profile" />
      <HotelTabs hotelId={id} active="profile" />
      <NextDeliveryCard hotelId={id} deliveries={deliveries} today={pragueToday()} />
      <ProfileGroups profile={profile} />
      <ContractsCard contracts={contracts} />
      <p className="text-xs text-stone-500">{cs.profile.managed}</p>
    </Shell>
  );
}
