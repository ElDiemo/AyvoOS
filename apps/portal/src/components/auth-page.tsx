import Link from 'next/link';
import wordmark from '@/assets/ayvo-wordmark.svg';
import { cs } from '@/i18n/cs';

/**
 * The signed-out pages (sign-in, activation, password recovery) in the portal's own look: the AYVO
 * wordmark as in the signed-in header, the form in the same card as the profile's sections, and
 * — where the user came from the sign-in — a way back to it.
 */
export function AuthPage({
  title,
  back = false,
  children,
}: {
  title: string;
  /** Shows "Zpět na přihlášení" (password recovery). */
  back?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-10">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG wordmark */}
        <img src={wordmark.src} alt={cs.brand} width={86} height={25} className="h-6 w-auto" />
        <span className="text-[11px] font-medium tracking-[0.18em] text-stone-500 uppercase">
          {cs.portalName}
        </span>
      </div>
      <section className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold text-stone-900">{title}</h1>
        {children}
      </section>
      {back && (
        <Link
          href="/login"
          className="w-fit rounded text-sm text-stone-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          data-testid="back-to-login"
        >
          ← {cs.backToLogin}
        </Link>
      )}
    </div>
  );
}
