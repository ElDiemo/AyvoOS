import { ModuleHeader } from '@/components/shell/module-header';
import type { SalesPageId } from '@/lib/navigation';

export function SalesHeader(props: {
  active: SalesPageId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return <ModuleHeader module="sales" {...props} />;
}
