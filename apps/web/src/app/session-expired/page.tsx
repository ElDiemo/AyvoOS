import type { Metadata } from 'next';
import { AuthPage, signInHref } from '@/components/auth-page';
import { buttonClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';

export const metadata: Metadata = { title: 'Relace vypršela – AYVO OS' };

export default async function SessionExpiredPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <AuthPage title={identityCs.expired.title}>
      <p>{identityCs.expired.text}</p>
      <a href={signInHref(next)} className={buttonClass.primary}>
        {identityCs.expired.button}
      </a>
    </AuthPage>
  );
}
