'use client';

import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CurrentUser } from '@ayvo/types';
import { useEffect, useRef, useState } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { identityCs } from '@/i18n/cs/identity';
import { shellCs } from '@/i18n/cs/shell';
import { locate, visibleModules, type NavModule } from '@/lib/navigation';
import { navigationClosed } from '@/lib/scan-focus';
import { SiteSwitcher } from './site-switcher';

type Environment = 'development' | 'test' | 'production';

/**
 * AYVO OS application shell (doc 019): a persistent left navigation (desktop) or a drawer
 * (phones, tablets), and a compact top bar with the location and the environment. The navigation
 * lists the overview, the operational modules and the administration — only those the signed-in
 * user's permissions allow (the API enforces them anyway); each module brings its own page
 * navigation. The user and the sign-out action are always visible.
 */
export function AppShell({
  environment,
  user,
  children,
}: {
  environment: Environment;
  user: CurrentUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const modules = visibleModules(user.permissions);
  const { module, page } = locate(pathname, modules);
  const drawer = useRef<HTMLDialogElement>(null);

  // A navigation closes the drawer (also for links inside the page, the back button…).
  useEffect(() => {
    drawer.current?.close();
  }, [pathname]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto bg-stone-950 lg:flex">
        <SidebarContent
          pathname={pathname}
          modules={modules}
          environment={environment}
          user={user}
        />
      </aside>

      <dialog
        ref={drawer}
        aria-label={shellCs.mainNav}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-stone-950 p-0 backdrop:bg-stone-950/50 lg:hidden"
        onClick={(e) => {
          // A click on the backdrop (outside the panel) closes the drawer.
          if (e.target === e.currentTarget) drawer.current?.close();
        }}
        // After the dialog restored its focus to the menu button: a scan page may take it back.
        onClose={() => setTimeout(navigationClosed, 0)}
      >
        <div className="flex h-full flex-col">
          <SidebarContent
            pathname={pathname}
            modules={modules}
            environment={environment}
            user={user}
          >
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
          <SiteSwitcher user={user} className="shrink-0" />
          <EnvironmentBadge environment={environment} withLabel />
          <span
            className="hidden max-w-48 truncate text-sm text-stone-600 md:inline"
            data-testid="current-user"
          >
            {user.user.displayName}
          </span>
          <LogoutButton className="hidden md:inline-flex" />
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
  user,
  children,
}: {
  pathname: string;
  modules: readonly NavModule[];
  environment: Environment;
  user: CurrentUser;
  children?: React.ReactNode;
}) {
  const { module: active } = locate(pathname, modules);
  const sales = modules.filter((m) => m.section === 'sales');
  const operations = modules.filter((m) => m.section === 'operations');
  const administration = modules.filter((m) => m.section === 'administration');
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-white/10 px-5 pt-5 pb-6">
        <Link href="/" className="flex items-baseline gap-2 text-white">
          <BrandLogo inverse compact />
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
        {/* Obchod (doc 034): its own block, apart from the operational modules below. */}
        {sales.length > 0 && <div className="mt-4" />}
        {sales.map((m) => (
          <NavLink key={m.id} href={m.href} active={active?.id === m.id} icon={ICONS[m.id]}>
            {m.label}
          </NavLink>
        ))}
        {operations.length > 0 && (
          <p className="mt-6 mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
            {shellCs.operations}
          </p>
        )}
        {operations.map((m) => (
          <NavLink key={m.id} href={m.href} active={active?.id === m.id} icon={ICONS[m.id]}>
            {m.label}
          </NavLink>
        ))}
        {administration.length > 0 && (
          <p className="mt-6 mb-1 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500">
            {identityCs.shell.administration}
          </p>
        )}
        {administration.map((m) => (
          <NavLink key={m.id} href={m.href} active={active?.id === m.id} icon={ICONS[m.id]}>
            {m.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-white/10 px-5 py-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-stone-500">
          {identityCs.shell.account}
        </p>
        <p className="mt-1 truncate text-sm text-white">{user.user.displayName}</p>
        <p className="truncate text-xs text-stone-400">{user.user.email}</p>
        <p className="mt-1 text-xs text-stone-400">{user.roles.map((r) => r.name).join(', ')}</p>
        <LogoutButton className="mt-3 w-full border-white/20 bg-transparent text-stone-200 hover:bg-white/10" />
      </div>
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
  // A handshake-like pair of strokes: Obchod (doc 034).
  sales: 'M3 11l4-4 4 3 3-3 7 6M3 11l5 5 2-1 2 2 2-1 2 2 4-4M10 10l3 3',
  overview: 'M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z',
  warehouse: 'M3 10l9-6 9 6v10H3zM7 20v-6h10v6M7 17h10',
  production: 'M4 20V9l5 3V9l5 3V5h6v15zM8 16h2M14 16h2',
  // A building with floors (hotels) and a crate on a truck bed (dispatch), same stroke style.
  hotels: 'M5 21V4h10v17M15 9h4v12M3 21h18M8 8h4M8 12h4M8 16h4',
  dispatch: 'M3 6h11v9H3zM14 9h4l3 3v3h-7M7 18a2 2 0 1 0 0-.01M17 18a2 2 0 1 0 0-.01',
  admin: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4',
} as const;

/** Ends the AYVO session (and the provider session where known), then leaves the page. */
function LogoutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-stone-700 transition hover:bg-stone-100 disabled:opacity-50',
        className,
      )}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch('/api/auth/logout', { method: 'POST' });
          const body = (await res.json().catch(() => ({}))) as { redirectUrl?: string };
          window.location.assign(res.ok && body.redirectUrl ? body.redirectUrl : '/login');
        } catch {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload drops all client state after the session ended
          window.location.assign('/login');
        }
      }}
    >
      {busy ? identityCs.shell.loggingOut : identityCs.shell.logout}
    </button>
  );
}

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
