import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { buttonClass, PageHeader } from '@/components/ui';

const TABS = [
  { id: 'bottles', href: '/bottles', label: 'Bottles' },
  { id: 'history', href: '/bottles/history', label: 'Creation history' },
] as const;

/**
 * Header of the Bottles module overview: title, the primary "Create bottles" action and the two
 * views (individual bottles, history of bottle creations). Each view is its own URL, so direct
 * links, refresh and the back button keep the selected view.
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
      <nav
        aria-label="Bottles views"
        className="-mt-4 mb-6 flex gap-1 overflow-x-auto border-b border-stone-200"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={tab.id === active ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition',
              tab.id === active
                ? 'border-stone-900 text-stone-900'
                : 'border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
