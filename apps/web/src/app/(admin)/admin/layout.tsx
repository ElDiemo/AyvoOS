import { requireAnyPermission } from '@/lib/session';

/** Section guard of the administration; each page checks its own permission again (and the API). */
export default async function GuardedLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission([
    'identity:users_read',
    'sites:manage',
    'carriers:connections_manage',
  ]);
  return children;
}
