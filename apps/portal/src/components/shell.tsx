import Link from 'next/link';
import { cs } from '@/i18n/cs';
import { LogoutButton } from './logout-button';

/** The signed-in portal: who, where, and the two sections of P1. */
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
      className={`rounded-md px-3 py-2 text-sm font-medium ${active === key ? 'bg-stone-900 text-white' : 'text-stone-700 hover:bg-stone-200'}`}
    >
      {cs.nav[key]}
    </Link>
  );
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">{cs.brand}</span>
          <span className="text-xs break-all text-stone-500">
            {user.displayName} · {user.email}
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-2">
          {link('/', 'hotels')}
          {link('/invoices', 'invoices')}
          <LogoutButton />
        </nav>
      </header>
      {testInvoices && (
        <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
          Testovací prostředí: faktury jsou TESTOVACÍ, ne daňové doklady.
        </p>
      )}
      <main className="flex flex-col gap-4">{children}</main>
    </div>
  );
}
