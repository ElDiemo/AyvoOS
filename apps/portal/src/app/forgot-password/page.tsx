import { AuthPage } from '@/components/auth-page';
import { ForgotForm } from '@/components/auth-forms';
import { cs } from '@/i18n/cs';

export default function Page() {
  return (
    <AuthPage title={cs.forgot.title} back>
      <ForgotForm />
    </AuthPage>
  );
}
