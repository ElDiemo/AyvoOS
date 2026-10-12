import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { visibleModules, type NavModule } from '@/lib/navigation';
import { currentUser } from '@/lib/session';

/**
 * Contextual navigation of one operational module (doc 019). Each page is its own URL, so
 * direct links, refresh and the back button keep the selected page. Wide screens wrap the tabs
 * (never a scrollbar); phones scroll them sideways without a visible scrollbar. Only the pages
 * the signed-in user may open are listed (the pages and the API check again).
 */
export async function ModuleNav({ module, active }: { module: NavModule['id']; active: string }) {
  const m = visibleModules((await currentUser()).permissions).find((x) => x.id === module);
  if (!m) return null;
  return (
    <nav aria-label={m.label} className="mb-6 border-b border-stone-200">
      <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden">
        {m.pages.map((page) => (
          <li key={page.id} className="shrink-0">
            <Link
              href={page.href}
              aria-current={page.id === active ? 'page' : undefined}
              className={cn(
                'block px-3 py-2.5 text-sm font-medium whitespace-nowrap transition',
                page.id === active
                  ? 'text-stone-950 shadow-[inset_0_-2px_0_0_var(--color-stone-950)]'
                  : 'text-stone-500 hover:text-stone-900 hover:shadow-[inset_0_-2px_0_0_var(--color-stone-300)]',
              )}
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Module navigation followed by the page title of a module page. */
export function ModuleHeader({
  module,
  active,
  title,
  subtitle,
  actions,
  back,
}: {
  module: NavModule['id'];
  active: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      <ModuleNav module={module} active={active} />
      <PageHeader title={title} subtitle={subtitle} actions={actions} back={back} />
    </>
  );
}

/** Secondary views inside one page (e.g. bottle list / creation history): a segmented control. */
export function ViewSwitch({
  label,
  views,
  active,
}: {
  label: string;
  views: readonly { id: string; href: string; label: string }[];
  active: string;
}) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-2">
      {views.map((v) => (
        <Link
          key={v.id}
          href={v.href}
          aria-current={v.id === active ? 'page' : undefined}
          className={cn(
            'rounded-full px-3 py-1 text-sm whitespace-nowrap',
            v.id === active
              ? 'bg-stone-900 text-white'
              : 'bg-stone-100 text-stone-700 hover:bg-stone-200',
          )}
        >
          {v.label}
        </Link>
      ))}
    </nav>
  );
}
