import { adminUserSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.admin;

export default async function UsersPage() {
  const [me, users] = await Promise.all([
    currentUser(),
    apiGet('admin/identity/users', z.array(adminUserSummarySchema)),
  ]);
  return (
    <>
      <AdminHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          hasPermission(me, 'identity:users_manage') ? (
            <Link href="/admin/users/new" className={buttonClass.primary}>
              {t.create}
            </Link>
          ) : null
        }
      />
      <Card className="relative overflow-x-auto p-0">
        {users.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="users">
            <thead className="border-b border-stone-200 text-xs tracking-wide text-stone-500 uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">{t.name}</th>
                <th className="px-5 py-3 font-medium">{t.roles}</th>
                <th className="px-5 py-3 font-medium">{t.status}</th>
                <th className="px-5 py-3 font-medium">{t.lastLogin}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-stone-50">
                  <td className="px-5 py-3 align-top">
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                      {u.displayName}
                    </Link>
                    <span className="block text-xs wrap-anywhere text-stone-500">{u.email}</span>
                  </td>
                  <td className="px-5 py-3 align-top">
                    {u.roles.length === 0 ? (
                      <span className="text-stone-400">{t.noRoles}</span>
                    ) : (
                      u.roles.map((r) => identityCs.roles[r] ?? r).join(', ')
                    )}
                  </td>
                  <td className="px-5 py-3 align-top whitespace-nowrap">
                    {u.status === 'ACTIVE' ? (
                      t.active
                    ) : (
                      <span className="text-red-800">{t.deactivated}</span>
                    )}
                    <span className="block text-xs text-stone-500">
                      {u.linked ? t.linked : t.notLinked}
                    </span>
                  </td>
                  <td className="px-5 py-3 align-top whitespace-nowrap text-stone-500">
                    {u.lastLoginAt ? formatDateTimeCs(u.lastLoginAt) : t.never}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
