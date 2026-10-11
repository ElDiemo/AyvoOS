import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthPage } from '@/components/auth-page';
import { buttonClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';

export const metadata: Metadata = { title: 'Nemáte oprávnění – AYVO OS' };

export default function ForbiddenPage() {
  return (
    <AuthPage title={identityCs.forbidden.title} tone="warning">
      <p>{identityCs.forbidden.text}</p>
      <Link href="/" className={buttonClass.secondary}>
        {identityCs.forbidden.home}
      </Link>
    </AuthPage>
  );
}
