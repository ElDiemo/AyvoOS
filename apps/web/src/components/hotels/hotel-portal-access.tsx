import 'server-only';
import {
  hotelBillingTermsSchema,
  portalAccountListItemSchema,
  type CurrentUser,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { payerNames } from '@/app/(admin)/hotels/users/payers';
import { Card, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { hotelUsersCs as t } from '@/i18n/cs/hotel-users';
import { apiGetPanel } from '@/lib/api';
import { hasPermission } from '@/lib/session';
import { AccountBadges } from './portal-account-card';

/** The payer page's portal section (Finance → Plátci → plátce → Přístup do portálu). */
export const payerPortalHref = (code: string) =>
  `/finance/billing/customers/${code}#pristup-do-portalu`;

/**
 * "Přístup do portálu" on one hotel's card: the portal accounts assigned to it by an active grant
 * (filtered on the server — never the list of all accounts), their account and invitation state,
 * and where to manage or invite (Finance's payer page — the one existing check Finance → core).
 * Shown only with `identity:portal_grants_manage`; the payer's link only with billing read.
 *
 * An assignment says only that the account is assigned to the hotel. Whether it is operational
 * access or invoices only is not recorded yet (review 5841786998, pending the owner's approval):
 * nothing here claims operational rights.
 */
export async function HotelPortalAccess({ hotelId, me }: { hotelId: string; me: CurrentUser }) {
  const canBilling = hasPermission(me, 'finance:billing_read');
  const [accounts, payers, terms] = await Promise.all([
    apiGetPanel('admin/identity/portal-accounts', z.array(portalAccountListItemSchema), {
      hotelId,
    }),
    payerNames(me),
    canBilling
      ? apiGetPanel(`admin/finance/billing/agreements/by-hotel/${hotelId}`, hotelBillingTermsSchema)
      : Promise.resolve(null),
  ]);
  const current = terms?.state === 'ok' ? (terms.data.terms?.customer ?? null) : null;
  return (
    <Card title={t.hotelCard.title} testId="hotel-portal-access" id="pristup-do-portalu">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-stone-500">{t.hotelCard.help}</p>
        {accounts.state !== 'ok' ? (
          <Notice tone="warning">{t.hotelCard.unavailable}</Notice>
        ) : accounts.data.length === 0 ? (
          <p className="text-stone-500 italic" data-testid="hotel-portal-access-empty">
            {t.hotelCard.none}
          </p>
        ) : (
          <ul className="divide-y divide-stone-100" data-testid="hotel-portal-access-list">
            {accounts.data.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-1 py-2"
                data-testid={`hotel-portal-account-${a.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/hotels/users/${a.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {a.displayName}
                    </Link>
                    <p className="break-all text-stone-600">{a.email}</p>
                  </div>
                  <AccountBadges account={a} />
                </div>
                {a.grants.map((g) => {
                  const payer = payers?.get(g.payerCustomerId);
                  return (
                    <p key={g.id} className="text-xs text-stone-500">
                      {t.hotelCard.assigned} {formatDateTimeCs(g.grantedAt)}
                      {payer && (
                        <>
                          {' · '}
                          {t.payer}{' '}
                          <Link
                            href={payerPortalHref(payer.code)}
                            className="underline underline-offset-2"
                          >
                            {payer.name}
                          </Link>
                        </>
                      )}
                    </p>
                  );
                })}
                <Link
                  href={`/hotels/users/${a.id}`}
                  className="self-start text-xs font-medium text-stone-700 underline underline-offset-2"
                >
                  {t.hotelCard.manageAccount}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {current ? (
          <Link
            href={payerPortalHref(current.code)}
            className="self-start rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
            data-testid="hotel-portal-access-invite"
          >
            {t.hotelCard.invite(current.customer.legalName)}
          </Link>
        ) : (
          <p className="text-xs text-stone-500" data-testid="hotel-portal-access-hint">
            {t.issueHint}
          </p>
        )}
      </div>
    </Card>
  );
}
