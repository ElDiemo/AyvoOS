import type { PortalContract } from '@ayvo/types';
import { cs } from '@/i18n/cs';
import { formatDate } from '@/lib/format';

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`;

/** "Smlouvy": the hotel's signed originals (never drafts), each downloadable as PDF. */
export function ContractsCard({
  contracts,
  heading = cs.contracts.title,
  headingId = 'contracts-title',
}: {
  contracts: PortalContract[] | null;
  /** The card's title (the hotel's name on the all-hotels page). */
  heading?: string;
  /** Unique per card on a page with several. */
  headingId?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      data-testid="profile-contracts"
      className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div>
        <h2 id={headingId} className="text-base font-semibold text-stone-900">
          {heading}
        </h2>
        <p className="text-xs text-stone-500">{cs.contracts.help}</p>
      </div>
      {contracts === null ? (
        <p className="text-sm text-amber-800">{cs.contracts.unavailable}</p>
      ) : contracts.length === 0 ? (
        <p className="text-sm text-stone-500 italic">{cs.contracts.none}</p>
      ) : (
        <ul className="flex flex-col">
          {contracts.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 py-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium text-stone-900">
                  {cs.contracts.signed(formatDate(c.signedOn))}
                </span>
                <span className="text-xs text-stone-500">
                  {cs.contracts.startOn(formatDate(c.startOn))} · PDF {size(c.byteSize)}
                </span>
              </div>
              <a
                href={`/contracts/${c.id}/pdf`}
                className="rounded-lg border border-emerald-900 px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-50"
              >
                {cs.contracts.download}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
