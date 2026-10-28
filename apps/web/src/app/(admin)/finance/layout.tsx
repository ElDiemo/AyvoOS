import { FINANCE_PERMISSIONS } from '@/lib/navigation';
import { requireAnyPermission } from '@/lib/session';

/**
 * Finance (doc 039–042): any Finance permission opens the module — the same list as its
 * navigation (received documents and exports finance:documents_read, contracts
 * finance:billing_read, invoices and payments finance:invoices_read, bank transactions
 * finance:bank_read, our company finance:issuer_manage); company-wide, no site. Each page and the
 * API check again.
 */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(FINANCE_PERMISSIONS);
  return children;
}
