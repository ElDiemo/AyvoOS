import type { DomesticVatRate } from '@ayvo/types';
import type { Prisma } from '../generated/finance-prisma/client.js';

type VatRateRow = Prisma.DomesticVatRateGetPayload<object>;

export const vatRateView = (r: VatRateRow): DomesticVatRate => ({
  revision: Number(r.revision),
  validFrom: r.validFrom.toISOString().slice(0, 10),
  ratePercent: r.ratePercent.toFixed(2),
  reason: r.reason,
  recordedAt: r.recordedAt.toISOString(),
  recordedByName: r.recordedByName,
});

/**
 * One entry per start day — the newest revision of that day corrects the earlier ones — newest
 * start first (doc 040 §17).
 */
export function effectiveVatRates(rows: DomesticVatRate[]): DomesticVatRate[] {
  const byDay = new Map<string, DomesticVatRate>();
  for (const r of rows) {
    const seen = byDay.get(r.validFrom);
    if (!seen || seen.revision < r.revision) byDay.set(r.validFrom, r);
  }
  return [...byDay.values()].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
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
  // One query: the latest start day not after the tax point, and of that day the newest revision
  // (its correction) — a later revision of another day never decides.
  const row = await tx.domesticVatRate.findFirst({
    where: { validFrom: { lte: new Date(`${taxPointOn}T00:00:00.000Z`) } },
    orderBy: [{ validFrom: 'desc' }, { revision: 'desc' }],
  });
  return row ? vatRateView(row) : null;
}
