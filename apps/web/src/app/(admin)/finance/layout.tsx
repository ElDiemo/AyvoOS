import { requirePermission } from '@/lib/session';

/** Finance (doc 039): finance:documents_read; company-wide, no site. Each page and the API check again. */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('finance:documents_read');
  return children;
}
