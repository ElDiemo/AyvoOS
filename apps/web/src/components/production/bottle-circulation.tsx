import type { BottleCirculation, BottleStatus } from '@ayvo/types';
import { StatusBadge } from '@ayvo/ui';
import Link from 'next/link';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';

const c = productionCs.circulation;

/**
 * Readiness (doc 048 §3.0a): a new labelled bottle and a washed one share the next step "K plnění"
 * (their source stays visible); a printed code with no label is "Kód čekající na nalepení", never
 * a bottle in stock. The exact status follows in small print.
 */
export function BottleReadiness({
  status,
  source,
}: {
  status: BottleStatus;
  source: BottleCirculation['source'] | undefined;
}) {
  const exact = productionCs.bottleStatus[status] ?? status;
  const toFill = status === 'LABELED_EMPTY' || status === 'READY_FOR_REUSE';
  const main =
    status === 'CREATED'
      ? c.readiness.CREATED
      : toFill
        ? `${c.readiness.TO_FILL}${source ? ` · ${c.source[source]}` : ''}`
        : exact;
  return (
    <span className="flex flex-col items-start gap-0.5" data-testid="bottle-readiness">
      <StatusBadge tone={toFill ? 'ok' : status === 'RETURNED' ? 'warning' : 'neutral'}>
        {main}
      </StatusBadge>
      {main !== exact && <span className="text-xs text-stone-500">{exact}</span>}
    </span>
  );
}

/** The active crate binding, or "bez bedny" — independent of the readiness. */
export function BottleCrate({ circulation }: { circulation: BottleCirculation | undefined }) {
  if (!circulation) return <span className="text-stone-400">{c.unknown}</span>;
  if (!circulation.crate) return <span className="text-stone-500">{c.noCrate}</span>;
  return (
    <span data-testid="bottle-crate">
      <Link
        href={`/production/crates/${circulation.crate.code}`}
        className="font-mono hover:underline"
      >
        {circulation.crate.code}
      </Link>{' '}
      <span className="text-xs text-stone-500">
        {cratesCs.cycleStatus[circulation.crate.cycleStatus] ?? circulation.crate.cycleStatus}
      </span>
    </span>
  );
}

/** The location derived from dispatch and the bottle's own return scan (never the crate's). */
export function BottleLocation({ circulation }: { circulation: BottleCirculation | undefined }) {
  if (!circulation) return <span className="text-stone-400">{c.unknown}</span>;
  const l = circulation.location;
  return (
    <span className="flex flex-col gap-0.5" data-testid="bottle-location">
      <span>{c.locationKind[l.kind] ?? l.kind}</span>
      {l.orderCode && (
        <span className="text-xs text-stone-500 wrap-anywhere">
          {c.order(l.orderCode, l.hotelName ?? '—')}
          {l.deliveredAt ? ` · ${c.delivered(formatDateTimeCs(l.deliveredAt))}` : ''}
        </span>
      )}
    </span>
  );
}
