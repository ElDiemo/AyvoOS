import { AppShell } from '@/components/shell/app-shell';
import { serverEnv } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Internal application shell (doc 019). Every page requires a signed-in, active user
 * (ADR 0022): without a session the API answers 401 and the user is sent to the sign-in page.
 * The navigation shows only what the user's permissions allow; the API enforces them anyway.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <AppShell environment={serverEnv.APP_ENV} user={user}>
      {children}
    </AppShell>
  );
}
