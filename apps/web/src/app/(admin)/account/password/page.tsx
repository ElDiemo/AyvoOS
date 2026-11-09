import type { Metadata } from 'next';
import { ChangePasswordForm } from '@/components/change-password-form';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Změnit heslo – AYVO OS',
  robots: { index: false, follow: false },
};

export default async function ChangePasswordPage() {
  await currentUser();
  return <ChangePasswordForm />;
}
