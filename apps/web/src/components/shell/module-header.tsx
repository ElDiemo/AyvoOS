import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';
import { visibleModules, type NavGroup, type NavModule, type NavPage } from '@/lib/navigation';
import { ActiveIntoView } from './active-into-view';
import { currentUser } from '@/lib/session';

type Section = 'overview' | NavGroup;

/**
 * Contextual navigation of one operational module (doc 019, doc 027, issue #11 UI-20). Each page
 * is its own URL, so direct links, refresh and the back button keep the selected page.
 *
 * A module with groups (Výroba) shows two levels: first the sections — Přehled, Práce, Evidence,
 * Nastavení výroby, only those with a page the user may open — and below them only the pages of
 * the active section. The section follows the current page, so it is visible from any URL. On a
 * phone the sections are a 2×2 grid (nothing hidden sideways); the page strip is short and keeps
 * the active page in view. A module without groups keeps its single strip. Placement is
 * orientation, never authorization: the pages and the API check the permissions on their own.
 */
export async function ModuleNav({ module, active }: { module: NavModule['id']; active: string }) {
  const m = visibleModules((await currentUser()).permissions).find((x) => x.id === module);
  if (!m) return null;
  const grouped = m.pages.some((p) => p.group);
  if (!grouped) {
    return (
      <nav aria-label={m.label} className="mb-6 border-b border-stone-200">
        <PageStrip pages={m.pages} active={active} />
      </nav>
    );
  }
  const sectionOf = (p: NavPage): Section => p.group ?? 'overview';
  const order: Section[] = ['overview', 'work', 'records', 'setup'];
  const sections = order
    .map((id) => ({ id, pages: m.pages.filter((p) => sectionOf(p) === id) }))
    .filter((s) => s.pages.length > 0);
  const current = m.pages.find((p) => p.id === active);
  const activeSection: Section | null = current ? sectionOf(current) : null;
  const pages = sections.find((s) => s.id === activeSection)?.pages ?? [];
  const t = shellCs.modules.production;
  return (
    <nav aria-label={m.label} className="mb-4 flex flex-col gap-2 sm:mb-6 sm:gap-3">
      <ul
        aria-label={t.sections.label}
        className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap"
        data-testid="module-sections"
      >
        {sections.map((s) => {
          const on = s.id === activeSection;
          return (
            <li key={s.id} className="min-w-0">
              <Link
                href={s.pages[0]!.href}
                aria-current={on ? 'true' : undefined}
                data-testid={`section-${s.id}`}
                data-active={on}
                className={cn(
                  'flex h-full min-w-0 flex-col rounded-lg border px-3 py-1.5 text-sm transition sm:py-2',
                  on
                    ? 'border-stone-900 bg-stone-900 text-white'
                    : s.id === 'work'
                      ? 'border-stone-900 bg-white font-medium text-stone-900 hover:bg-stone-100'
                      : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400',
                )}
              >
                <span className="font-medium">{t.sections[s.id]}</span>
                {s.id !== 'overview' && (
                  <span
                    className={cn(
                      'hidden text-xs sm:block',
                      on ? 'text-stone-300' : 'text-stone-500',
                    )}
                  >
                    {t.sectionHelp[s.id]}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {/* Evidence and Nastavení always name their pages (also a single, read-only one). */}
      {(activeSection === 'records' || activeSection === 'setup') && pages.length > 0 && (
        <div className="border-b border-stone-200">
          <PageStrip pages={pages} active={active} />
        </div>
      )}
    </nav>
  );
}

/** One row of page tabs; on phones it scrolls sideways and keeps the active page in view. */
function PageStrip({ pages, active }: { pages: readonly NavPage[]; active: string }) {
  return (
    <ActiveIntoView className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden">
      {pages.map((item) => (
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
      ))}
    </ActiveIntoView>
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
