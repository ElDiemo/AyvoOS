import { domainError } from '../common/domain-error.js';
import type { Prisma } from '../generated/finance-prisma/client.js';

/**
 * The number series of issued hotel invoices (owner 2026-11-03, doc 040 §16): the year of issue,
 * the series digit, five digits of order — `2026100001`. The same digits are the variable symbol
 * (QR Platba, PDF, export). Not used by any issuing path yet: live issuing stays behind the gate of
 * doc 040 §5; TEST invoices keep their own `T<year>-…` series (§9).
 */
export const HOTEL_INVOICE_SERIES = 1;
export const HOTEL_INVOICE_SEQUENCE_MAX = 99_999;

/** The counter of one year and series in `finance.code_counters`; it starts at the first use. */
export const hotelInvoiceCounter = (year: number, series: number) =>
  `hotel_invoice:${year}:${series}`;

/** `2026`, `1`, `1n` → `2026100001`. Refuses what would not be exactly ten digits. */
export function hotelInvoiceNumber(year: number, series: number, sequence: bigint): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999)
    throw new Error(`Invoice year out of range: ${year}`);
  if (!Number.isInteger(series) || series < 1 || series > 9)
    throw new Error(`Invoice series out of range: ${series}`);
  if (sequence < 1n || sequence > BigInt(HOTEL_INVOICE_SEQUENCE_MAX))
    throw new Error(`Invoice sequence out of range: ${sequence}`);
  return `${year}${series}${sequence.toString().padStart(5, '0')}`;
}

/**
 * Allocates the next number of the series for an invoice issued on `issuedOn` (the Prague date of
 * issue, `YYYY-MM-DD`) — never from the billed period. Call it inside the issuing transaction,
 * after everything that may still refuse the invoice: the counter row stays locked until the
 * commit and rolls back with it, so a number exists only together with its issued invoice and is
 * never handed out twice. After 99 999 in a year it refuses (409) and the counter stays.
 */
export async function allocateHotelInvoiceNumber(
  tx: Prisma.TransactionClient,
  issuedOn: string,
  series: number = HOTEL_INVOICE_SERIES,
): Promise<{ number: string; variableSymbol: string; year: number; sequence: bigint }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) throw new Error(`Not a date: ${issuedOn}`);
  const year = Number(issuedOn.slice(0, 4));
  const name = hotelInvoiceCounter(year, series);
  const rows = await tx.$queryRaw<{ last_value: bigint }[]>`
    INSERT INTO "finance"."code_counters" ("name", "last_value") VALUES (${name}, 1)
    ON CONFLICT ("name") DO UPDATE SET "last_value" = "code_counters"."last_value" + 1
      WHERE "code_counters"."last_value" < ${HOTEL_INVOICE_SEQUENCE_MAX}
    RETURNING "last_value"`;
  const sequence = rows[0]?.last_value;
  if (sequence === undefined)
    throw domainError(
      409,
      'NUMBER_SERIES_FULL',
      `Číselná řada ${year}${series} je vyčerpána (${HOTEL_INVOICE_SEQUENCE_MAX} faktur). Nic se nevystavilo.`,
    );
  const number = hotelInvoiceNumber(year, series, sequence);
  return { number, variableSymbol: number, year, sequence };
}
