import { requirePermission } from '@/lib/session';

/** Section guard (doc 028): orders need orders:read; each page and the API check again. */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('orders:read');
  return children;
}
