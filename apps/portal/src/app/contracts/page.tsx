import type { Metadata } from 'next';
import { ContractsCard } from '@/components/contracts-card';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { portalEnv } from '@/lib/env';
import { perHotel } from '@/lib/per-hotel';
import { myContracts, myHotels, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Smlouvy' };

/** "Smlouvy" of every hotel of the account (main navigation): signed originals only, per hotel. */
export default async function AllContractsPage() {
  const { token, view } = await portalSession();
  const hotels = await myHotels(token);
  const contracts = await perHotel(
    hotels.map((h) => h.id),
    (id) => myContracts(token, id),
  );
  return (
    <Shell user={view.user} active="contracts" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-stone-900">{cs.allContracts.title}</h1>
        <p className="text-sm text-stone-600">{cs.allContracts.intro}</p>
      </div>
      {hotels.length === 0 ? (
        <p className="text-sm text-stone-600">{cs.hotels.none}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="all-contracts">
          {hotels.map((h) => (
            <ContractsCard
              key={h.id}
              heading={h.name}
              headingId={`contracts-${h.id}`}
              contracts={contracts.get(h.id) ?? null}
            />
          ))}
        </div>
      )}
    </Shell>
  );
}
