import { cn } from '@ayvo/ui';
import Link from 'next/link';

/**
 * Tab bar of a module's views. Each view is its own URL, so direct links, refresh and the back
 * button keep the selected view.
 */
export function SectionTabs({
  label,
  tabs,
  active,
}: {
  label: string;
  tabs: readonly { id: string; href: string; label: string }[];
  active: string;
}) {
  return (
    <nav
      aria-label={label}
      className="-mt-4 mb-6 flex gap-1 overflow-x-auto border-b border-stone-200"
    >
      {tabs.map((tab) => (
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
  );
}
