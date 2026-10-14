import { publicBottlePassportSchema, publicCrateSchema } from '@ayvo/types';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { apiGetPublic } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'AYVO' };

/**
 * Public QR target. A bottle token shows the bottle passport (whitelisted public DTO: no internal
 * ids, no operator, warehouse or hotel data, no CO2e — doc 011). A crate token shows only that
 * this is a returnable AYVO crate (doc 020 §3.4): no code, site, hotel, contents or history.
 */
export default async function PublicQrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const path = encodeURIComponent(token);
  const passport = await apiGetPublic(`public/bottles/${path}`, publicBottlePassportSchema);
  const crate = passport ? null : await apiGetPublic(`public/crates/${path}`, publicCrateSchema);
  if (!passport && !crate) notFound();
  return (
    <main
      lang="en"
      className="flex min-h-screen items-center justify-center bg-stone-100 px-6 py-16"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-stone-200">
        <p className="text-2xl font-semibold tracking-[0.35em] text-stone-900">AYVO</p>
        {passport ? (
          <>
            <h1 className="mt-10 font-mono text-lg">Bottle {passport.bottleCode}</h1>
            <p className="mt-2 text-sm text-stone-600">Registered reusable AYVO bottle</p>
            <div className="mt-10 border-t border-stone-100 pt-6">
              <p className="text-xs uppercase tracking-wide text-stone-500">Reuse cycles</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums" data-testid="reuse-cycles">
                {passport.reuseCycles}
              </p>
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-10 text-lg font-medium" data-testid="public-crate">
              Returnable AYVO crate
            </h1>
            <p className="mt-2 text-sm text-stone-600">Property of AYVO. This crate is reused.</p>
          </>
        )}
      </div>
    </main>
  );
}
