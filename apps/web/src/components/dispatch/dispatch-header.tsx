import { ModuleHeader } from '@/components/shell/module-header';
import type { DispatchPageId } from '@/lib/navigation';

export function DispatchHeader(props: {
  active: DispatchPageId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return <ModuleHeader module="dispatch" {...props} />;
}
