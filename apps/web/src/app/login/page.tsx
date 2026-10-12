import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthPage, signInHref } from '@/components/auth-page';
import { buttonClass, ErrorNote, Notice } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { safeNextPath } from '@/lib/safe-path';
import { optionalUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Přihlášení – AYVO OS' };
const t = identityCs.login;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; signed_out?: string }>;
}) {
  const { next, error, signed_out: signedOut } = await searchParams;
  // Already signed in: continue instead of showing the sign-in page again.
  if (await optionalUser()) redirect(safeNextPath(next));
  return (
    <AuthPage title={t.title}>
      {signedOut && <Notice tone="info">{t.signedOut}</Notice>}
      {error && <ErrorNote>{t.invalid}</ErrorNote>}
      <p>{t.text}</p>
      <a href={signInHref(next)} className={`${buttonClass.primary} w-full`} data-testid="sign-in">
        {t.button}
      </a>
    </AuthPage>
  );
}
