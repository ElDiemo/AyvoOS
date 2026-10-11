import { cn } from '@ayvo/ui';
import Link from 'next/link';

/**
 * Small layout primitives for the admin UI (AYVO: calm, minimal, stone palette).
 * Values such as template names (up to 64 characters without spaces), codes and URLs may have no
 * break opportunity: the primitives let them wrap (`wrap-anywhere` + `min-w-0`) so that a long
 * value never widens the page on a phone.
 */

export const buttonClass = {
  primary:
    'inline-flex max-w-full items-center justify-center gap-2 text-center wrap-anywhere rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex max-w-full items-center justify-center gap-2 text-center wrap-anywhere rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-800 shadow-sm transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50',
  danger:
    'inline-flex max-w-full items-center justify-center gap-2 text-center wrap-anywhere rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-red-600 disabled:opacity-50',
} as const;

export const inputClass =
  'block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-stone-500 focus:ring-2 focus:ring-stone-200 disabled:bg-stone-100';

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1 wrap-anywhere">
        {back && (
          <Link href={back.href} className="text-sm text-stone-500 hover:text-stone-800">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-stone-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-stone-200 bg-white p-6 shadow-sm', className)}>
      {title && (
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-stone-500">{title}</h2>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="mt-2 text-sm text-stone-500 first:mt-0 sm:mt-0">{label}</dt>
      <dd className="min-w-0 text-sm text-stone-900 wrap-anywhere">{children}</dd>
    </>
  );
}

export function FieldList({ children }: { children: React.ReactNode }) {
  // Phones: label above value; wider screens: two columns, the value column may shrink.
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] sm:gap-y-3">
      {children}
    </dl>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      {children}
    </p>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-stone-500">{children}</p>;
}
