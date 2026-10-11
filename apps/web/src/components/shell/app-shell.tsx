'use client';

import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { shellCs } from '@/i18n/cs/shell';
import { locate, visibleModules, type NavModule } from '@/lib/navigation';

type Environment = 'development' | 'test' | 'production';

/**
 * AYVO OS application shell (doc 019): a persistent left navigation (desktop) or a drawer
 * (phones, tablets), and a compact top bar with the location and the environment. The navigation
 * lists the overview and the operational modules only; each module brings its own page
 * navigation. No user or role is shown: application accounts do not exist yet (ADR 0017).
 */
export function AppShell({
  environment,
  children,
}: {
  environment: Environment;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const modules = visibleModules();
  const { module, page } = locate(pathname, modules);
  const drawer = useRef<HTMLDialogElement>(null);

  // A navigation closes the drawer (also for links inside the page, the back button…).
  useEffect(() => {
    drawer.current?.close();
  }, [pathname]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto bg-stone-950 lg:flex">
        <SidebarContent pathname={pathname} modules={modules} environment={environment} />
      </aside>

      <dialog
        ref={drawer}
        aria-label={shellCs.mainNav}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-stone-950 p-0 backdrop:bg-stone-950/50 lg:hidden"
        onClick={(e) => {
          // A click on the backdrop (outside the panel) closes the drawer.
          if (e.target === e.currentTarget) drawer.current?.close();
        }}
      >
        <div className="flex h-full flex-col">
          <SidebarContent pathname={pathname} modules={modules} environment={environment}>
            <button
              type="button"
              onClick={() => drawer.current?.close()}
              aria-label={shellCs.closeMenu}
              className="rounded-md p-2 text-stone-400 hover:bg-white/10 hover:text-white"
            >
              <Icon path="M6 6l12 12M18 6L6 18" />
            </button>
          </SidebarContent>
        </div>
      </dialog>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-stone-200 bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => drawer.current?.showModal()}
            aria-label={shellCs.openMenu}
            aria-haspopup="dialog"
            className="-ml-2 rounded-md p-2 text-stone-700 hover:bg-stone-100 lg:hidden"
          >
            <Icon path="M4 7h16M4 12h16M4 17h16" />
          </button>
          <nav aria-label={shellCs.breadcrumb} className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-2 text-sm">
              {module ? (
                <>
                  <li className="shrink-0">
                    <Link href={module.href} className="text-stone-500 hover:text-stone-900">
                      {module.label}
                    </Link>
                  </li>
                  <li aria-hidden className="shrink-0 text-stone-300">
                    /
                  </li>
                  <li className="min-w-0 truncate font-medium text-stone-900" aria-current="page">
                    {page?.label}
                  </li>
                </>
              ) : (
                <li className="truncate font-medium text-stone-900" aria-current="page">
                  {shellCs.overview}
                </li>
              )}
            </ol>
          </nav>
          <EnvironmentBadge environment={environment} withLabel />
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarContent({
  pathname,
  modules,
  environment,
  children,
}: {
  pathname: string;
  modules: readonly NavModule[];
  environment: Environment;
  children?: React.ReactNode;
}) {
  const { module: active } = locate(pathname, modules);
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-6">
        <Link href="/" className="flex items-baseline gap-2 text-white">
          <span className="text-lg font-semibold tracking-[0.25em]">{shellCs.brand}</span>
          <span className="text-sm text-stone-400">{shellCs.brandSuffix}</span>
        </Link>
        <div className="flex items-center gap-1">
          <EnvironmentBadge environment={environment} />
          {children}
        </div>
      </div>
      <nav aria-label={shellCs.mainNav} className="flex flex-col gap-1 px-3 pb-6">
        <NavLink href="/" active={pathname === '/'} icon={ICONS.overview}>
          {shellCs.overview}
        </NavLink>
        <p className="mt-6 mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
          {shellCs.operations}
        </p>
        {modules.map((m) => (
          <NavLink key={m.id} href={m.href} active={active?.id === m.id} icon={ICONS[m.id]}>
            {m.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition',
        active ? 'bg-white text-stone-950' : 'text-stone-300 hover:bg-white/10 hover:text-white',
      )}
    >
      <Icon path={icon} />
      {children}
    </Link>
  );
}

/** Non-production environments are always marked; production shows no badge. */
export function EnvironmentBadge({
  environment,
  withLabel = false,
}: {
  environment: Environment;
  withLabel?: boolean;
}) {
  if (environment === 'production') return null;
  const env = shellCs.environment[environment];
  return (
    <span className="flex shrink-0 items-center gap-2" title={env.label}>
      <span
        className="rounded bg-amber-400 px-1.5 py-0.5 text-[11px] font-bold tracking-wider text-stone-950"
        data-testid="environment-badge"
      >
        {env.badge}
      </span>
      {withLabel && <span className="hidden text-xs text-stone-500 xl:inline">{env.label}</span>}
      {!withLabel && <span className="sr-only">{env.label}</span>}
    </span>
  );
}

const ICONS = {
  overview: 'M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z',
  warehouse: 'M3 10l9-6 9 6v10H3zM7 20v-6h10v6M7 17h10',
  production: 'M4 20V9l5 3V9l5 3V5h6v15zM8 16h2M14 16h2',
} as const;

function Icon({ path }: { path: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
