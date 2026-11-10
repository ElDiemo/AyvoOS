import { AuthPage } from '@/components/auth-page';
import { ResetForm } from '@/components/auth-forms';
import { cs } from '@/i18n/cs';

export default function Page() {
  return (
    <AuthPage title={cs.reset.title} back>
      <ResetForm />
    </AuthPage>
  );
}
