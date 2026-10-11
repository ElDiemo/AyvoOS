import { AppShell } from '@/components/shell/app-shell';
import { serverEnv } from '@/lib/env';

/**
 * Internal application shell (doc 019). On DEV the whole site is behind Basic Auth; application
 * authentication and permission-filtered navigation come later (ADR 0017).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AppShell environment={serverEnv.APP_ENV}>{children}</AppShell>;
}
