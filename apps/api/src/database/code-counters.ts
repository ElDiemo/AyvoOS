import type { Prisma } from '../generated/prisma/client.js';

/** Names of the rows in `code_counters` (seeded by the migration). */
export type CodeCounterName =
  | 'bottle'
  | 'bottle_creation_batch'
  | 'label_print_job'
  | 'goods_receipt'
  | 'crate_registration'
  | 'crate'
  | 'hotel'
  | 'order'
  | 'shipment'
  | 'print_job'
  | 'sales_prospect'
  | 'sales_import'
  | 'finance_document'
  | 'accounting_export';

/**
 * Allocates `count` consecutive serials from a gapless counter. Must run inside the business
 * transaction: the UPDATE takes a row lock that serialises concurrent allocations until commit,
 * and a rollback returns the range, so codes are unique, contiguous per call and gapless.
 * Callers that allocate from several counters must always lock them in the same order
 * (bottle_creation_batch → bottle → label_print_job; crate_registration → crate) to avoid deadlocks.
 */
export async function allocateSerials(
  tx: Prisma.TransactionClient,
  name: CodeCounterName,
  count: number,
): Promise<{ first: bigint; last: bigint }> {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('count must be a positive integer');
  const rows = await tx.$queryRaw<{ last_value: bigint }[]>`
    UPDATE code_counters SET last_value = last_value + ${count}
    WHERE name = ${name}
    RETURNING last_value`;
  const last = rows[0]?.last_value;
  if (last === undefined) throw new Error(`Code counter "${name}" is missing`);
  return { first: last - BigInt(count) + 1n, last };
}
