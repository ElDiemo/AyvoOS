import type { PortalAccountListItem } from '@ayvo/types';
import Link from 'next/link';
import { hotelUsersCs as t } from '@/i18n/cs/hotel-users';
import { formatDateTimeCs } from '@/i18n/cs/format';

export type Payers = Map<string, { code: string; name: string }>;

const badge = (tone: 'ok' | 'muted' | 'warn', text: string) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      tone === 'ok'
        ? 'bg-emerald-50 text-emerald-800'
        : tone === 'warn'
          ? 'bg-amber-50 text-amber-900'
          : 'bg-stone-100 text-stone-600'
    }`}
  >
    {text}
  </span>
);

/** The account's state and its invitation's. */
export function AccountBadges({
  account,
}: {
  account: Pick<PortalAccountListItem, 'status' | 'invitation'>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {badge(account.status === 'ACTIVE' ? 'ok' : 'muted', t.status[account.status]!)}
      {badge(
        account.invitation === 'ACTIVE'
          ? 'ok'
          : ['DELIVERY_FAILED', 'EXPIRED', 'FAILED'].includes(account.invitation)
            ? 'warn'
            : 'muted',
        t.invitation[account.invitation]!,
      )}
    </div>
  );
}

/** The payer of a grant: its name and a link to its Finance page when known, else its id. */
function Payer({ id, payers }: { id: string; payers: Payers | null }) {
  const payer = payers?.get(id);
  if (!payer)
    return (
      <span className="text-stone-600">
        {t.payerUnknown} <span className="font-mono text-xs">{id.slice(0, 8)}</span>
      </span>
    );
  return (
    <Link
      href={`/finance/billing/customers/${payer.code}#pristup-do-portalu`}
      className="underline-offset-2 hover:underline"
    >
      {payer.name} <span className="font-mono text-xs text-stone-500">{payer.code}</span>
    </Link>
  );
}

/** One grant: its payer and hotels. */
export function GrantRow({
  grant,
  payers,
  children,
}: {
  grant: PortalAccountListItem['grants'][number];
  payers: Payers | null;
  children?: React.ReactNode;
}) {
  return (
    <li
      className="flex flex-col gap-1 border-t border-stone-100 py-2 text-sm first:border-t-0"
      data-testid={`portal-grant-${grant.id}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs text-stone-500">{t.payer}:</span>
        <Payer id={grant.payerCustomerId} payers={payers} />
      </div>
      <ul className="flex flex-wrap gap-2">
        {grant.hotels.map((h) => (
          <li key={h.id}>
            <Link
              href={`/hotels/${h.code}#pristup-do-portalu`}
              className="rounded-md border border-stone-200 px-2 py-0.5 text-xs hover:bg-stone-50"
            >
              {h.name} <span className="font-mono text-stone-500">{h.code}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-stone-500">
        {t.grantedAt} {formatDateTimeCs(grant.grantedAt)}
        {grant.revokedAt &&
          ` · ${t.revokedAt} ${formatDateTimeCs(grant.revokedAt)}${grant.revokeReason ? ` (${grant.revokeReason})` : ''}`}
      </p>
      {children}
    </li>
  );
}

/** A hotel portal account: who, its state, its invitation and its active grants. */
export function PortalAccountSummary({
  account,
  payers,
  link,
  grants = true,
}: {
  account: PortalAccountListItem;
  payers: Payers | null;
  link?: boolean;
  /** false: the grants are shown separately (the account's detail). */
  grants?: boolean;
}) {
  const active = account.grants.filter((g) => !g.revokedAt);
  const revoked = account.grants.length - active.length;
  return (
    <div className="flex flex-col gap-3" data-testid={`portal-account-${account.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {link ? (
            <Link
              href={`/hotels/users/${account.id}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {account.displayName}
            </Link>
          ) : (
            <p className="font-medium">{account.displayName}</p>
          )}
          <p className="text-sm break-all text-stone-600">{account.email}</p>
        </div>
        <AccountBadges account={account} />
      </div>
      <p className="text-xs text-stone-500">
        {t.lastLogin}: {account.lastLoginAt ? formatDateTimeCs(account.lastLoginAt) : t.never} ·{' '}
        {t.sessions}: {account.activeSessions}
        {account.deactivatedAt && ` · ${t.deactivated} ${formatDateTimeCs(account.deactivatedAt)}`}
      </p>
      {grants &&
        (active.length === 0 ? (
          <p className="text-sm text-stone-500 italic">{t.noActiveGrant}</p>
        ) : (
          <ul>
            {active.map((g) => (
              <GrantRow key={g.id} grant={g} payers={payers} />
            ))}
          </ul>
        ))}
      {revoked > 0 && link && <p className="text-xs text-stone-500">{t.revokedGrants(revoked)}</p>}
    </div>
  );
}
