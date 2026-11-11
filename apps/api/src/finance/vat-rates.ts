import type { DomesticVatRate, DomesticVatRateRevision } from '@ayvo/types';
import type { Prisma } from '../generated/finance-prisma/client.js';

type VatRateRow = Prisma.DomesticVatRateGetPayload<object>;

export const vatRateRevisionView = (r: VatRateRow): DomesticVatRateRevision => ({
  revision: Number(r.revision),
  validFrom: r.validFrom.toISOString().slice(0, 10),
  kind: r.kind as DomesticVatRateRevision['kind'],
  ratePercent: r.ratePercent?.toFixed(2) ?? null,
  reason: r.reason,
  recordedAt: r.recordedAt.toISOString(),
  recordedByName: r.recordedByName,
});

/**
 * One entry per start day — the newest revision of that day corrects the earlier ones; a day whose
 * newest revision withdraws it has none (an older revision never comes back) — newest start first
 * (doc 040 §17).
 */
export function effectiveVatRates(rows: DomesticVatRateRevision[]): DomesticVatRate[] {
  const byDay = new Map<string, DomesticVatRateRevision>();
  for (const r of rows) {
    const seen = byDay.get(r.validFrom);
    if (!seen || seen.revision < r.revision) byDay.set(r.validFrom, r);
  }
  return [...byDay.values()]
    .filter((r) => r.kind === 'RATE' && r.ratePercent !== null)
    .map(({ kind: _kind, ratePercent, ...r }) => ({ ...r, ratePercent: ratePercent! }))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
}

/** The rate that applies on `day` (YYYY-MM-DD): the latest start day not after it; null = none. */
export const vatRateOn = (effective: DomesticVatRate[], day: string): DomesticVatRate | null =>
  effective.find((r) => r.validFrom <= day) ?? null;

/**
 * The default domestic VAT rate for a tax point, read in the caller's transaction — the contract
 * for live issuing (doc 040 §17): chosen by the tax point (DUZP), frozen into the issued document,
 * and null means the live domestic invoice is refused (DOMESTIC_VAT_RATE_MISSING). Only for the
 * domestic regime: a foreign or special tax regime never falls back to it. Not called by any
 * issuing path yet; TEST invoices compute no VAT.
 */
export async function domesticVatRateOn(
  tx: Prisma.TransactionClient,
  taxPointOn: string,
): Promise<DomesticVatRate | null> {
  // One query: of the start days not after the tax point the newest revision of each (validFrom
  // DESC, revision DESC) — a later revision of another day never decides — then the latest day
  // whose newest revision is a rate: a withdrawn day hands over to the previous one, never to an
  // older revision of itself. Two decimals exactly (the column holds at most two).
  const [row] = await tx.$queryRaw<
    {
      revision: bigint;
      valid_from: string;
      rate_percent: string;
      reason: string;
      recorded_at: Date;
      recorded_by_name: string;
    }[]
  >`
    SELECT "revision", "valid_from"::text AS "valid_from",
           "rate_percent"::numeric(5, 2)::text AS "rate_percent",
           "reason", "recorded_at", "recorded_by_name"
      FROM (SELECT DISTINCT ON ("valid_from") *
              FROM "finance"."domestic_vat_rates"
             WHERE "valid_from" <= ${taxPointOn}::date
             ORDER BY "valid_from" DESC, "revision" DESC) AS "newest"
     WHERE "kind" = 'RATE'
     ORDER BY "valid_from" DESC
     LIMIT 1`;
  return row
    ? {
        revision: Number(row.revision),
        validFrom: row.valid_from,
        ratePercent: row.rate_percent,
        reason: row.reason,
        recordedAt: row.recorded_at.toISOString(),
        recordedByName: row.recorded_by_name,
      }
    : null;
}
