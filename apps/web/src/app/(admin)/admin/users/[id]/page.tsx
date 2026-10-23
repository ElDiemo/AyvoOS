import { adminUserDetailSchema, assignableSitesSchema, roleCatalogSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AccessPreview } from '@/components/admin/access-preview';
import { AdminHeader } from '@/components/admin/admin-header';
import { AuditList } from '@/components/admin/audit-list';
import { UserAccessEditor } from '@/components/admin/user-access-editor';
import { UserActions } from '@/components/admin/user-actions';
import { EmployeeCardEditor } from '@/components/admin/employee-card-editor';
import { buttonClass, Card, Field, FieldList, Notice } from '@/components/ui';
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
        actions={
          hasPermission(me, 'identity:users_manage') ? (
            <a href="#vizitka" className={buttonClass.secondary}>
              Veřejná vizitka
            </a>
          ) : undefined
        }
      />
      {user.invitation?.state === 'FAILED' && (
        <div className="mb-4" data-testid="invitation-warning">
          <Notice tone="warning">{t.invitationFailed}</Notice>
        </div>
      )}
      {user.invitation?.state === 'SENDING' && (
        <div className="mb-4" data-testid="invitation-warning">
          <Notice tone="warning">{t.invitationUnconfirmed}</Notice>
        </div>
      )}
      {/*
        Three blocks (issue #11, UI-03): overview, editing, audit. One column (phones, tablets):
        overview → editing → audit, so a long audit never pushes the editor down. Wide screens: the
        editing column on the right spans both rows; the second row absorbs its extra height.
      */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem] xl:grid-rows-[auto_1fr]">
        <div className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-1">
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
        </div>
        {hasPermission(me, 'identity:users_manage') && (
          <div
            className="flex min-w-0 flex-col gap-6 xl:col-start-2 xl:row-span-2 xl:row-start-1"
            data-testid="user-editing"
          >
            <UserAccessEditor user={user} roles={roles} sites={sites} />
            <UserActions user={user} isSelf={me.user.id === user.id} />
          </div>
        )}
        <Card
          title={t.audit}
          className="relative min-w-0 self-start overflow-x-auto xl:col-start-1 xl:row-start-2"
        >
          <AuditList events={user.audit} testId="user-audit" />
        </Card>
      </div>
      {hasPermission(me, 'identity:users_manage') && (
        <div className="mt-6">
          <EmployeeCardEditor
            userId={user.id}
            displayName={user.displayName}
            active={user.status === 'ACTIVE'}
          />
        </div>
      )}
    </>
  );
}
