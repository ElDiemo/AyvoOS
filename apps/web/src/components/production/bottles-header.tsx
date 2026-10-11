import Link from 'next/link';
import { ProductionHeader } from '@/components/production/production-header';
import { ViewSwitch } from '@/components/shell/module-header';
import { buttonClass } from '@/components/ui';
import { productionCs } from '@/i18n/cs/production';

const b = productionCs.bottles;
const VIEWS = [
  { id: 'list', href: '/bottles', label: b.list },
  { id: 'history', href: '/bottles/history', label: b.history },
] as const;

/**
 * Header of Výroba → Lahve: the primary "Vytvořit lahve" action and the two views (individual
 * bottles, history of bottle creations).
 */
export function BottlesHeader({
  active,
  subtitle,
}: {
  active: (typeof VIEWS)[number]['id'];
  subtitle?: React.ReactNode;
}) {
  return (
    <>
      <ProductionHeader
        active="bottles"
        title={b.title}
        subtitle={subtitle}
        actions={
          <Link href="/bottles/new" className={buttonClass.primary}>
            {b.create}
          </Link>
        }
      />
      <ViewSwitch label={b.views} views={VIEWS} active={active} />
    </>
  );
}
