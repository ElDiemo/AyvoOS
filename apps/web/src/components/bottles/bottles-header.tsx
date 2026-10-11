import Link from 'next/link';
import { SectionTabs } from '@/components/section-tabs';
import { buttonClass, PageHeader } from '@/components/ui';

const TABS = [
  { id: 'bottles', href: '/bottles', label: 'Bottles' },
  { id: 'history', href: '/bottles/history', label: 'Creation history' },
] as const;

/**
 * Header of the Bottles module overview: title, the primary "Create bottles" action and the two
 * views (individual bottles, history of bottle creations).
 */
export function BottlesHeader({
  active,
  subtitle,
}: {
  active: (typeof TABS)[number]['id'];
  subtitle?: React.ReactNode;
}) {
  return (
    <>
      <PageHeader
        title="Bottles"
        subtitle={subtitle}
        actions={
          <Link href="/bottles/new" className={buttonClass.primary}>
            Create bottles
          </Link>
        }
      />
      <SectionTabs label="Bottles views" tabs={TABS} active={active} />
    </>
  );
}
