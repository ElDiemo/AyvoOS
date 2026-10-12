import { requireAnyPermission } from '@/lib/session';

/**
 * Section guard: the warehouse opens with full stock access or the planning summary (SALES). Each
 * page below checks its own permission again; the API enforces every permission on its own.
 */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(['inventory:read', 'inventory:stock_summary']);
  return children;
}
