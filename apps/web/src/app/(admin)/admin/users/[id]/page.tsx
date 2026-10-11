import { adminUserDetailSchema, roleCatalogSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { UserActions } from '@/components/admin/user-actions';
import { Card, Field, FieldList } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.admin;

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [me, user, roles, warehouses] = await Promise.all([
    currentUser(),
    apiGet(`admin/identity/users/${id}`, adminUserDetailSchema),
    apiGet('admin/identity/roles', roleCatalogSchema),
    apiGet('admin/identity/warehouses', z.array(z.object({ code: z.string(), name: z.string() }))),
  ]);
  return (
    <>
      <AdminHeader
        title={<span className="wrap-anywhere">{user.displayName}</span>}
        subtitle={<span className="wrap-anywhere">{user.email}</span>}
        back={{ href: '/admin/users', label: t.back }}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <FieldList>
              <Field label={t.status}>
                <span data-testid="user-status">
                  {user.status === 'ACTIVE' ? t.active : t.deactivated}
                </span>
                {user.deactivationReason && (
                  <span className="block text-xs text-stone-500">{user.deactivationReason}</span>
                )}
              </Field>
              <Field label={t.roles}>
                <span data-testid="user-roles">
                  {user.roles.length
                    ? user.roles.map((r) => identityCs.roles[r] ?? r).join(', ')
                    : t.noRoles}
                </span>
              </Field>
              <Field label={t.warehouses}>
                {user.scopes
                  .map((s) => s.locationCode)
                  .filter(Boolean)
                  .join(', ') || t.noWarehouses}
              </Field>
              <Field label={t.lastLogin}>
                {user.lastLoginAt ? formatDateTimeCs(user.lastLoginAt) : t.never} ·{' '}
                {user.linked ? t.linked : t.notLinked} · {t.sessions(user.activeSessions)}
              </Field>
            </FieldList>
          </Card>
          <Card title={t.audit} className="relative overflow-x-auto">
            {user.audit.length === 0 ? (
              <p className="text-sm text-stone-500">{t.noAudit}</p>
            ) : (
              <ol
                className="flex flex-col divide-y divide-stone-100 text-sm"
                data-testid="user-audit"
              >
                {user.audit.map((a) => (
                  <li key={a.id} className="py-2">
                    <span className="font-medium">{t.auditTypes[a.type] ?? a.type}</span>
                    {typeof a.details.role === 'string' &&
                      ` · ${identityCs.roles[a.details.role] ?? a.details.role}`}
                    {typeof a.details.warehouse === 'string' && ` · ${a.details.warehouse}`}
                    <span className="block text-xs wrap-anywhere text-stone-500">
                      {formatDateTimeCs(a.occurredAt)}
                      {a.actor ? ` · ${a.actor}` : ''}
                      {a.reason ? ` · ${a.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
        {hasPermission(me, 'identity:users_manage') && (
          <UserActions
            user={user}
            roles={roles}
            warehouses={warehouses}
            isSelf={me.user.id === user.id}
          />
        )}
      </div>
    </>
  );
}
