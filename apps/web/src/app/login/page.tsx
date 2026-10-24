import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { NativeSignIn } from '@/components/native-sign-in';
import { safeNextPath } from '@/lib/safe-path';
import { optionalUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Přihlášení – AYVO OS' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    error?: string;
    signed_out?: string;
    password_reset?: string;
  }>;
}) {
  const { next, signed_out: signedOut, password_reset: passwordReset } = await searchParams;
  // Already signed in: continue instead of showing the sign-in page again.
  if (await optionalUser()) redirect(safeNextPath(next));
  return (
    <NativeSignIn
      next={safeNextPath(next)}
      signedOut={Boolean(signedOut)}
      passwordReset={Boolean(passwordReset)}
    />
  );
}
