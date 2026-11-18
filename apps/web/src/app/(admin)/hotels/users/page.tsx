import { portalAccountListItemSchema } from '@ayvo/types';
import { z } from 'zod';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { PortalAccountSummary } from '@/components/hotels/portal-account-card';
import { Card, EmptyState, Notice } from '@/components/ui';
import { hotelUsersCs as t } from '@/i18n/cs/hotel-users';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';
import { payerNames } from './payers';

export const dynamic = 'force-dynamic';

/** Hotely → Uživatelé: the hotel portal accounts and their grants (never internal users). */
export default async function HotelUsersPage() {
  const me = await requirePermission('identity:portal_grants_manage');
  const [accounts, payers] = await Promise.all([
    apiGet('admin/identity/portal-accounts', z.array(portalAccountListItemSchema)),
    payerNames(me),
  ]);
  return (
    <>
      <HotelsHeader active="users" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-4">
        <Notice tone="info">{t.issueHint}</Notice>
        {accounts.length === 0 ? (
          <Card>
            <EmptyState>{t.empty}</EmptyState>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="portal-accounts">
            {accounts.map((a) => (
              <li key={a.id}>
                <Card>
                  <PortalAccountSummary account={a} payers={payers} link />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
