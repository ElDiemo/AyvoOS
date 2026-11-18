import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProfileForm } from '@/components/profile-form';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalRefusal } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { myHotelProfile, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

/** "Upravit profil hotelu": the whitelisted fields of a granted hotel, in three groups. */
export default async function EditHotelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { token, view } = await portalSession();
  const profile = await myHotelProfile(token, id).catch((e: unknown) => {
    if (e instanceof PortalRefusal && e.status === 404) notFound();
    throw e;
  });
  return (
    <Shell user={view.user} active="hotels" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <Link
        href={`/hotels/${id}`}
        className="w-fit text-sm text-stone-600 underline-offset-2 hover:underline"
      >
        <span aria-hidden="true">←</span> {cs.profile.back}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-stone-900">{cs.profile.editTitle}</h1>
        <p className="text-sm text-stone-600">
          {profile.name} · {profile.countryCode}
        </p>
      </div>
      <ProfileForm profile={profile} />
    </Shell>
  );
}
