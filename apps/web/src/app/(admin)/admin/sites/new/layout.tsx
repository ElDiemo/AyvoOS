import { requirePermission } from '@/lib/session';

/** Page-level guard of this section; the API enforces the same permission on every request. */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('sites:manage');
  return children;
}
