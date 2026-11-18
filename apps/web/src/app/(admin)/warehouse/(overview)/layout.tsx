import { requireAnyPermission } from '@/lib/session';

/**
 * Page-level guard of Zásoby: the warehouse (inventory:read) or the planning view
 * (inventory:stock_summary); the API enforces each contract's own permission on every request.
 */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(['inventory:read', 'inventory:stock_summary']);
  return children;
}
