import type { Metadata } from 'next';
import { AuthPage, signInHref } from '@/components/auth-page';
import { buttonClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';

export const metadata: Metadata = { title: 'Účet není aktivní – AYVO OS' };
const t = identityCs.inactive;

export default async function AccountInactivePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const noAccess = (await searchParams).reason === 'no-access';
  return (
    <AuthPage title={noAccess ? t.noAccessTitle : t.title} tone="warning">
      <p>{noAccess ? t.noAccess : t.text}</p>
      <a href={signInHref('/')} className={buttonClass.secondary}>
        {t.login}
      </a>
    </AuthPage>
  );
}
