import Link from 'next/link';
import wordmark from '@/assets/ayvo-wordmark.svg';
import { cs } from '@/i18n/cs';
import { LogoutButton } from './logout-button';

/**
 * The signed-in portal: the AYVO header, who is signed in, and the finished sections only (no
 * placeholder for features that do not exist yet).
 */
export function Shell({
  user,
  active,
  testInvoices,
  children,
}: {
  user: { displayName: string; email: string };
  active: 'hotels' | 'invoices';
  testInvoices?: boolean;
  children: React.ReactNode;
}) {
  const link = (href: string, key: 'hotels' | 'invoices') => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={`-mb-px border-b-2 px-1 pt-2 pb-3 text-sm font-medium ${
        active === key
          ? 'border-emerald-800 text-emerald-950'
          : 'border-transparent text-stone-600 hover:border-stone-300 hover:text-stone-900'
      }`}
    >
      {cs.nav[key]}
    </Link>
  );
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 pt-4">
          <Link href="/" className="flex items-center gap-3" aria-label={cs.brand}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG wordmark */}
            <img src={wordmark.src} alt="" width={86} height={25} className="h-6 w-auto" />
            <span className="text-[11px] font-medium tracking-[0.18em] text-stone-500 uppercase">
              {cs.portalName}
            </span>
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 truncate text-right text-xs text-stone-600" title={user.email}>
              <span className="font-medium text-stone-800">{user.displayName}</span>
              <span className="hidden sm:inline"> · {user.email}</span>
            </span>
            <LogoutButton />
          </div>
        </div>
        <nav aria-label={cs.nav.label} className="mx-auto mt-2 flex max-w-5xl gap-6 px-4">
          {link('/', 'hotels')}
          {link('/invoices', 'invoices')}
        </nav>
      </header>
      {testInvoices && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
          Testovací prostředí: faktury jsou TESTOVACÍ, ne daňové doklady.
        </p>
      )}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
