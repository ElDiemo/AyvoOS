import { ModuleHeader } from '@/components/shell/module-header';
import type { ProductionPageId } from '@/lib/navigation';

/** Header of a production page (doc 019): module navigation and page title. */
export function ProductionHeader({
  active,
  title,
  subtitle,
  back,
  actions,
}: {
  active: ProductionPageId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return (
    <ModuleHeader
      module="production"
      active={active}
      title={title}
      subtitle={subtitle}
      back={back}
      actions={actions}
    />
  );
}
