import { redirect } from 'next/navigation';
import { requireAnyPermission } from '@/lib/session';

/**
 * Former page, merged into Sklad → Zásoby (owner 2026-11-16). The URL stays as a redirect after
 * the access of Zásoby (either permission) is checked — before redirecting, so sign-in and /forbidden behave as before.
 */
export default async function FormerStockPage(): Promise<never> {
  await requireAnyPermission(['inventory:read', 'inventory:stock_summary']);
  redirect('/warehouse');
}
