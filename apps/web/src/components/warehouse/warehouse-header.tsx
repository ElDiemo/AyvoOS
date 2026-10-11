import { ModuleHeader } from '@/components/shell/module-header';
import type { WarehousePageId } from '@/lib/navigation';

/** Header of a warehouse page (doc 018 §10, doc 019): module navigation and page title. */
export function WarehouseHeader({
  active,
  title,
  subtitle,
  back,
  actions,
}: {
  active: WarehousePageId;
  title: string;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return (
    <ModuleHeader
      module="warehouse"
      active={active}
      title={title}
      subtitle={subtitle}
      back={back}
      actions={actions}
    />
  );
}
