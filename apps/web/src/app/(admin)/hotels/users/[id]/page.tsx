import { portalAccountListItemSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { payerPortalHref } from '@/components/hotels/hotel-portal-access';
import { GrantRow, PortalAccountSummary } from '@/components/hotels/portal-account-card';
import { AccountStatusAction, RevokeGrant } from '@/components/hotels/portal-account-actions';
import { buttonClass, Card, Notice } from '@/components/ui';
import { hotelUsersCs as t } from '@/i18n/cs/hotel-users';
import { apiGetOptional } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';
import { payerNames } from '../payers';

export const dynamic = 'force-dynamic';

/** One hotel portal account: its grants (revocable), its state and deactivation. */
export default async function HotelUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const me = await requirePermission('identity:portal_grants_manage');
  const [account, payers] = await Promise.all([
    apiGetOptional(`admin/identity/portal-accounts/${id}`, portalAccountListItemSchema),
    payerNames(me),
  ]);
  if (!account) notFound();
  const revoked = account.grants.filter((g) => g.revokedAt);
  return (
    <>
      <HotelsHeader
        active="users"
        title={account.displayName}
        subtitle={t.detail}
        back={{ href: '/hotels/users', label: t.back }}
      />
      <div className="flex flex-col gap-4">
        <Card>
          <PortalAccountSummary account={account} payers={payers} grants={false} />
        </Card>
        <Card title={t.grants}>
          <div className="mb-3">
            <Notice tone="info">{t.issueHint}</Notice>
          </div>
          {account.grants.some((g) => !g.revokedAt) ? (
            <ul>
              {account.grants
                .filter((g) => !g.revokedAt)
                .map((g) => (
                  <GrantRow key={g.id} grant={g} payers={payers}>
                    <div className="flex flex-wrap items-center gap-3">
                      {payers?.get(g.payerCustomerId) && (
                        <Link
                          href={payerPortalHref(payers.get(g.payerCustomerId)!.code)}
                          className={buttonClass.secondary}
                          data-testid={`portal-grant-manage-${g.id}`}
                        >
                          {t.manageInFinance}
                        </Link>
                      )}
                      <RevokeGrant grantId={g.id} />
                    </div>
                  </GrantRow>
                ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-500 italic">{t.noActiveGrant}</p>
          )}
          {revoked.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t.revokedGrants(revoked.length)}
              </summary>
              <ul className="mt-2">
                {revoked.map((g) => (
                  <GrantRow key={g.id} grant={g} payers={payers} />
                ))}
              </ul>
            </details>
          )}
        </Card>
        <Card title={t.actions.title}>
          {hasPermission(me, 'identity:users_manage') ? (
            <AccountStatusAction accountId={account.id} active={account.status === 'ACTIVE'} />
          ) : (
            <p className="text-sm text-stone-500">{t.actions.noManage}</p>
          )}
        </Card>
      </div>
    </>
  );
}
