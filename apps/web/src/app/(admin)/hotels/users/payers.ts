import 'server-only';
import { billingCustomerSchema } from '@ayvo/types';
import { z } from 'zod';
import type { Payers } from '@/components/hotels/portal-account-card';
import { apiGetPanel } from '@/lib/api';
import type { CurrentUser } from '@ayvo/types';
import { hasPermission } from '@/lib/session';

/**
 * The payers' names from Finance (its customers) — only for a viewer who may read billing, and
 * never bringing the page down: without them the grant shows the payer's id.
 */
export async function payerNames(me: CurrentUser): Promise<Payers | null> {
  if (!hasPermission(me, 'finance:billing_read')) return null;
  const res = await apiGetPanel('admin/finance/billing/customers', z.array(billingCustomerSchema));
  if (res.state !== 'ok') return null;
  return new Map(res.data.map((c) => [c.id, { code: c.code, name: c.current.customer.legalName }]));
}
