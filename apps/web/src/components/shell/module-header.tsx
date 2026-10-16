import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { buttonClass, PageHeader } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';
import { visibleModules, type NavGroup, type NavModule, type NavPage } from '@/lib/navigation';
import { ActiveIntoView } from './active-into-view';
import { currentUser } from '@/lib/session';

/**
 * Contextual navigation of one operational module (doc 019, doc 027). Each page is its own URL,
 * so direct links, refresh and the back button keep the selected page. The work entry (Práce) is
 * a prominent button; the other pages are grouped (Evidence, Nastavení výroby) with headings.
 * Wide screens wrap the tabs; phones scroll them sideways and the active one is brought into
 * view (UI-08). Only the pages the signed-in user may open are listed (the pages and the API
 * check again); placement in a group is orientation, not authorization.
 */
export async function ModuleNav({ module, active }: { module: NavModule['id']; active: string }) {
  const m = visibleModules((await currentUser()).permissions).find((x) => x.id === module);
  if (!m) return null;
  const work = m.pages.filter((p) => p.group === 'work');
  const tabs: (NavPage | { heading: NavGroup })[] = [];
  for (const group of [undefined, 'records', 'setup'] as const) {
    const pages = m.pages.filter((p) => p.group === group);
    if (pages.length === 0) continue;
    if (group) tabs.push({ heading: group });
    tabs.push(...pages);
  }
  const groups = shellCs.modules.production.groups;
  return (
    <nav aria-label={m.label} className="mb-6 border-b border-stone-200">
      {work.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="work-entry">
          {work.map((page) => (
            <Link
              key={page.id}
              href={page.href}
              aria-current={page.id === active ? 'page' : undefined}
              className={cn(buttonClass.primary, 'gap-2')}
            >
              {page.label}
            </Link>
          ))}
        </div>
      )}
      <ActiveIntoView className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden">
        {tabs.map((item) =>
          'heading' in item ? (
            <li
              key={`h-${item.heading}`}
              className="shrink-0 pl-3 pr-1 text-[0.7rem] font-semibold uppercase tracking-wide text-stone-400 first:pl-0"
              data-testid={`nav-group-${item.heading}`}
            >
              {item.heading === 'records' ? groups.records : groups.setup}
            </li>
          ) : (
            <li key={item.id} className="shrink-0">
              <Link
                href={item.href}
                aria-current={item.id === active ? 'page' : undefined}
                className={cn(
                  'block px-3 py-2.5 text-sm font-medium whitespace-nowrap transition',
                  item.id === active
                    ? 'text-stone-950 shadow-[inset_0_-2px_0_0_var(--color-stone-950)]'
                    : 'text-stone-500 hover:text-stone-900 hover:shadow-[inset_0_-2px_0_0_var(--color-stone-300)]',
                )}
              >
                {item.label}
                {item.readOnly && (
                  <span className="text-xs font-normal text-stone-400">
                    {' '}
                    ({shellCs.modules.production.readOnly})
                  </span>
                )}
              </Link>
            </li>
          ),
        )}
      </ActiveIntoView>
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
