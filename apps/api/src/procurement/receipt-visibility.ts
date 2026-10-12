import type { GoodsReceipt, PermissionCode } from '@ayvo/types';

/**
 * Field-level visibility of a goods receipt (doc 021): purchase prices need
 * `procurement:cost_read`, supplier documents need `procurement:documents_read`. Applied to every
 * receipt response on the server — including idempotent replays — so a restricted user never
 * receives the values, whatever the UI shows. Restricted fields are omitted, not nulled (null
 * means "not entered").
 */
export function receiptForViewer(
  receipt: GoodsReceipt,
  permissions: ReadonlySet<PermissionCode>,
): GoodsReceipt {
  const costs = permissions.has('procurement:cost_read');
  const documents = permissions.has('procurement:documents_read');
  const visible: GoodsReceipt = {
    ...receipt,
    lines: receipt.lines.map((line) => {
      if (costs) return line;
      const withoutCosts = { ...line };
      delete withoutCosts.unitPrice;
      delete withoutCosts.currency;
      delete withoutCosts.vatRate;
      return withoutCosts;
    }),
  };
  if (!documents) delete visible.documents;
  return visible;
}
