/**
 * Finance's check of a grant's hotels as the core receives it (v6, #148), for tests that write a
 * grant directly: AGREEMENT (operations, checked in `revision`, until `until`) or INVOICE (invoices
 * only).
 */
export const operationsCheck = (
  hotelIds: readonly string[],
  options: { revision?: number; until?: string | null } = {},
) => ({
  payerVersion: 1,
  hotels: [...hotelIds].sort().map((id) => ({
    id,
    basis: 'AGREEMENT' as const,
    checkedRevision: options.revision ?? 1,
    operationsUntil: options.until ?? null,
  })),
  checkedAt: new Date().toISOString(),
});

export const invoicesCheck = (hotelIds: readonly string[]) => ({
  payerVersion: 1,
  hotels: [...hotelIds].sort().map((id) => ({
    id,
    basis: 'INVOICE' as const,
    checkedRevision: null,
    operationsUntil: null,
  })),
  checkedAt: new Date().toISOString(),
});
