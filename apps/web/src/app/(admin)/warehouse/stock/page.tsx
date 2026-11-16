import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/session';

/**
 * Former page, merged into Sklad → Zásoby (owner 2026-11-16). The URL stays as a redirect after
 * the access it had (inventory:read) is checked — before redirecting, so sign-in and /forbidden behave as before.
 */
export default async function FormerStockPage(): Promise<never> {
  await requirePermission('inventory:read');
  redirect('/warehouse');
}
