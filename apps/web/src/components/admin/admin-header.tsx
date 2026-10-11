import { ModuleHeader } from '@/components/shell/module-header';

/** Header of the administration pages (users and roles). */
export function AdminHeader(props: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return <ModuleHeader module="admin" active="users" {...props} />;
}
