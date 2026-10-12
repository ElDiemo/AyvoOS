import { cn } from '@ayvo/ui';
import { safeNextPath } from '@/lib/safe-path';

/** Centered page for sign-in and access messages (outside the application shell). */
export function AuthPage({
  title,
  tone = 'neutral',
  children,
}: {
  title: string;
  tone?: 'neutral' | 'warning';
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-100 px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-xl font-semibold tracking-[0.3em] text-stone-900">
          AYVO <span className="text-sm font-normal tracking-normal text-stone-400">OS</span>
        </p>
        <h1 className={cn('mt-8 text-xl font-semibold', tone === 'warning' && 'text-amber-900')}>
          {title}
        </h1>
        <div className="mt-3 flex flex-col gap-4 text-sm text-stone-700">{children}</div>
      </div>
    </main>
  );
}

/** "Sign in" link: the API starts the identity-provider flow and returns to `next` afterwards. */
export function signInHref(next: string | undefined): string {
  const safe = safeNextPath(next);
  return `/api/auth/login?next=${encodeURIComponent(safe)}`;
}
