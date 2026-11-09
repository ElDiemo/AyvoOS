import Link from 'next/link';
import {
  AccountSecurityForm,
  ChangePasswordForm,
  LogoutEverywhere,
} from '@/components/account-security';
import { Shell } from '@/components/shell';
import { account } from '@/i18n/account';
import { portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

/** "Zabezpečení účtu": replacing the authenticator app (the session is checked by the core now). */
export default async function AccountPage() {
  const { view } = await portalSession();
  return (
    <Shell user={view.user}>
      <div className="flex max-w-md flex-col gap-4">
        <h1 className="text-xl font-semibold">{account.title}</h1>
        <p className="text-sm text-stone-600">{account.intro}</p>
        <AccountSecurityForm />
        <hr className="border-stone-200" />
        <ChangePasswordForm />
        <hr className="border-stone-200" />
        <LogoutEverywhere />
        <Link href="/" className="text-sm underline">
          {account.back}
        </Link>
      </div>
    </Shell>
  );
}
