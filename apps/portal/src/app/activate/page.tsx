import { AuthPage } from '@/components/auth-page';
import { ActivateForm } from '@/components/auth-forms';
import { cs } from '@/i18n/cs';

export default function Page() {
  return (
    <AuthPage title={cs.activate.title}>
      <ActivateForm />
    </AuthPage>
  );
}
