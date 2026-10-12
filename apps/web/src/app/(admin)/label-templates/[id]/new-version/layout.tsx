import { requirePermission } from '@/lib/session';

/** Company-wide templates change only with the global permission (the API enforces it too). */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('production:templates_manage');
  return children;
}
