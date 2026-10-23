import { requirePermission } from '@/lib/session';

/** Obchod (doc 034): sales:work; no site is needed. Each page and the API check again. */
export default async function SalesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('sales:work');
  return children;
}
