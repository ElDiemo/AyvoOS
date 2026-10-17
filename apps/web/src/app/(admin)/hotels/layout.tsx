import { requirePermission } from '@/lib/session';

/** Section guard (doc 028): hotels need hotels:read; each page and the API check again. */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('hotels:read');
  return children;
}
