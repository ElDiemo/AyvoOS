import { AuthPage } from '@/components/auth-page';
import { LoginForm } from '@/components/auth-forms';
import { LogoutPending } from '@/components/logout-pending';
import { cs } from '@/i18n/cs';
import { LOGOUT_PENDING_COOKIE, readCookie } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const logoutPending = (await readCookie(LOGOUT_PENDING_COOKIE)) !== null;
  return (
    <AuthPage title={cs.login.title}>
      {logoutPending && <LogoutPending />}
      <LoginForm reset={(await searchParams).reset === '1'} />
    </AuthPage>
  );
}
