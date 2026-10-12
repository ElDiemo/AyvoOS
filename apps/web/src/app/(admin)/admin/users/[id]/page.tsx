import { adminUserDetailSchema, assignableSitesSchema, roleCatalogSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AccessPreview } from '@/components/admin/access-preview';
import { AdminHeader } from '@/components/admin/admin-header';
import { AuditList } from '@/components/admin/audit-list';
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
  const [me, user, roles, sites] = await Promise.all([
    currentUser(),
    apiGet(`admin/identity/users/${id}`, adminUserDetailSchema),
    apiGet('admin/identity/roles', roleCatalogSchema),
    apiGet('admin/identity/sites', assignableSitesSchema),
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
                  {user.roles.length ? user.roles.map((r) => r.name).join(', ') : t.noRoles}
                </span>
              </Field>
              <Field label={t.invitation}>
                <span data-testid="invitation-state">
                  {user.invitation ? t.invitationStates[user.invitation.state] : t.noInvitation}
                </span>
                {user.invitation?.state === 'PENDING' && user.invitation.expiresAt && (
                  <span className="block text-xs text-stone-500">
                    {t.invitationExpires(formatDateTimeCs(user.invitation.expiresAt))}
                  </span>
                )}
              </Field>
              <Field label={t.lastLogin}>
                {user.lastLoginAt ? formatDateTimeCs(user.lastLoginAt) : t.never} ·{' '}
                {user.linked ? t.linked : t.notLinked} · {t.sessions(user.activeSessions)}
              </Field>
            </FieldList>
          </Card>
          <Card title={t.effective}>
            <p className="mb-3 text-xs text-stone-500">{t.effectiveHelp}</p>
            <AccessPreview
              permissions={user.effectiveAccess.permissions}
              sites={user.effectiveAccess.sites}
              global={user.effectiveAccess.globalSiteAccess}
            />
          </Card>
          <Card title={t.audit} className="relative overflow-x-auto">
            <AuditList events={user.audit} testId="user-audit" />
          </Card>
        </div>
        {hasPermission(me, 'identity:users_manage') && (
          <UserActions user={user} roles={roles} sites={sites} isSelf={me.user.id === user.id} />
        )}
      </div>
    </>
  );
}
