import { ModuleHeader } from '@/components/shell/module-header';
import type { AdminPageId } from '@/lib/navigation';

/** Header of the administration pages (users, roles, sites). */
export function AdminHeader({
  active = 'users',
  ...props
}: {
  active?: AdminPageId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return <ModuleHeader module="admin" active={active} {...props} />;
}
