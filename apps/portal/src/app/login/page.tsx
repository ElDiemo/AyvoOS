import { AuthPage } from '@/components/auth-page';
import { LoginForm } from '@/components/auth-forms';
import { cs } from '@/i18n/cs';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  return (
    <AuthPage title={cs.login.title}>
      <LoginForm reset={(await searchParams).reset === '1'} />
    </AuthPage>
  );
}
