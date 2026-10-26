import { requireAnyPermission } from '@/lib/session';

/**
 * Finance (doc 039, doc 041): received documents and exports need finance:documents_read, bank
 * transactions finance:bank_read; company-wide, no site. Each page and the API check again.
 */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(['finance:documents_read', 'finance:bank_read']);
  return children;
}
