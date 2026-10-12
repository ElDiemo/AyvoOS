'use client';

import {
  adminUserDetailSchema,
  type AdminUserDetail,
  type AssignableSites,
  type RoleCatalog,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';
const chip = 'flex items-center gap-2 rounded-full bg-stone-100 py-1 pr-1 pl-3 text-sm';
const chipButton =
  'rounded-full px-2 py-0.5 text-xs text-red-800 hover:bg-red-50 disabled:opacity-40';

/**
 * Role, site, warehouse and status changes of one user. One shared, required reason field: every
 * change is audited with it and applies to the user's next request.
 */
export function UserActions({
  user,
  roles,
  sites,
  isSelf,
}: {
  user: AdminUserDetail;
  roles: RoleCatalog;
  sites: AssignableSites;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [role, setRole] = useState('');
  const [site, setSite] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ path: string; requestId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonOk = reason.trim().length >= 3;
  const held = new Set(user.roles.map((r) => r.code));
  const grantable = roles.filter((r) => r.active && !held.has(r.code));
  const siteScopes = user.scopes.filter((s) => s.type === 'SITE');
  const warehouseScopes = user.scopes.filter((s) => s.type === 'WAREHOUSE');
  const missingSites = sites.filter((s) => !siteScopes.some((x) => x.siteId === s.id));
  // A warehouse only narrows a site the user already has.
  const narrowable = sites
    .filter((s) => siteScopes.some((x) => x.siteId === s.id))
    .flatMap((s) => s.warehouses.map((w) => ({ ...w, site: s })))
    .filter((w) => !warehouseScopes.some((x) => x.locationCode === w.code));

  async function run(path: string, body: Record<string, unknown>): Promise<unknown> {
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', `admin/identity/users/${user.id}/${path}`, adminUserDetailSchema, {
        ...body,
        reason,
      });
      setReason('');
      router.refresh();
      return null;
    } catch (err) {
      setError(errorText(err));
      return err;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Invitation actions are idempotent per request id. One user attempt keeps its request id —
   * repeating it after a network error or an unanswered provider call continues the same action
   * on the server — until it ends with success or a definite result.
   */
  async function invite(path: string) {
    const requestId = attempt?.path === path ? attempt.requestId : crypto.randomUUID();
    setAttempt({ path, requestId });
    const error = await run(path, { requestId });
    const retryable =
      error !== null &&
      (!(error instanceof ClientApiError) ||
        error.code === 'INVITATION_PROVIDER_UNAVAILABLE' ||
        error.code === 'INVITATION_IN_PROGRESS');
    if (!retryable) setAttempt(null);
  }

  const disabled = busy || !reasonOk;
  return (
    <Card title={t.reason}>
      <div className="flex flex-col gap-5" data-testid="user-actions">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t.reasonPlaceholder}
          aria-label={t.reason}
          className={inputClass}
        />
        {error && <ErrorNote>{error}</ErrorNote>}

        <section className="flex flex-col gap-2">
          <h3 className={label}>{t.roles}</h3>
          <ul className="flex flex-wrap gap-2">
            {user.roles.length === 0 && <li className="text-sm text-stone-500">{t.noRoles}</li>}
            {user.roles.map((r) => (
              <li key={r.code} className={chip}>
                <span className="wrap-anywhere">{r.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('roles/revoke', { role: r.code })}
                  className={chipButton}
                  aria-label={`${t.revoke}: ${r.name}`}
                >
                  {t.revoke}
                </button>
              </li>
            ))}
          </ul>
          {grantable.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                aria-label={t.roles}
                className={inputClass}
              >
                <option value="">—</option>
                {grantable.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                    {r.system ? '' : ` (${t.customRole})`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={disabled || !role}
                onClick={() => void run('roles/grant', { role }).then(() => setRole(''))}
                className={`${buttonClass.secondary} shrink-0 whitespace-nowrap`}
              >
                {t.grant}
              </button>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className={label}>{t.sites}</h3>
          <ul className="flex flex-wrap gap-2" data-testid="user-sites">
            {siteScopes.length === 0 && <li className="text-sm text-stone-500">{t.noSites}</li>}
            {siteScopes.map((s) => (
              <li key={s.id} className={chip}>
                <span className="font-mono">{s.siteCode}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('sites/revoke', { siteId: s.siteId })}
                  className={chipButton}
                  aria-label={`${t.revoke}: ${s.siteCode}`}
                >
                  {t.revoke}
                </button>
              </li>
            ))}
          </ul>
          {missingSites.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={site}
                onChange={(e) => setSite(e.target.value)}
                aria-label={t.sites}
                className={inputClass}
              >
                <option value="">—</option>
                {missingSites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={disabled || !site}
                onClick={() => void run('sites/grant', { siteId: site }).then(() => setSite(''))}
                className={`${buttonClass.secondary} shrink-0 whitespace-nowrap`}
              >
                {t.grant}
              </button>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className={label}>{t.narrowWarehouses}</h3>
          <ul className="flex flex-wrap gap-2">
            {warehouseScopes.length === 0 && (
              <li className="text-sm text-stone-500">{t.allWarehouses}</li>
            )}
            {warehouseScopes.map((w) => (
              <li key={w.id} className={`${chip} font-mono`}>
                {w.locationCode}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('warehouses/revoke', { warehouseCode: w.locationCode })}
                  className={`${chipButton} font-sans`}
                  aria-label={`${t.revoke}: ${w.locationCode}`}
                >
                  {t.revoke}
                </button>
              </li>
            ))}
          </ul>
          {narrowable.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
                aria-label={t.narrowWarehouses}
                className={inputClass}
              >
                <option value="">—</option>
                {narrowable.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.site.code} · {w.name} ({w.code})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={disabled || !warehouse}
                onClick={() =>
                  void run('warehouses/grant', { warehouseCode: warehouse }).then(() =>
                    setWarehouse(''),
                  )
                }
                className={`${buttonClass.secondary} shrink-0 whitespace-nowrap`}
              >
                {t.grant}
              </button>
            </div>
          )}
        </section>

        {!user.linked && user.status === 'ACTIVE' && (
          <section className="flex flex-col gap-2" data-testid="invitation-actions">
            <h3 className={label}>{t.invitation}</h3>
            <div className="flex flex-wrap gap-2">
              {(!user.invitation ||
                ['EXPIRED', 'REVOKED', 'FAILED'].includes(user.invitation.state)) && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void invite('invitations/resend')}
                  className={`${buttonClass.secondary} whitespace-nowrap`}
                >
                  {user.invitation ? t.resendInvitation : t.sendInvitation}
                </button>
              )}
              {user.invitation && ['PENDING', 'SENDING'].includes(user.invitation.state) && (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void invite('invitations/resend')}
                    className={`${buttonClass.secondary} whitespace-nowrap`}
                  >
                    {t.resendInvitation}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void invite('invitations/revoke')}
                    className={`${buttonClass.danger} whitespace-nowrap`}
                  >
                    {t.revokeInvitation}
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className={label}>{t.status}</h3>
          {user.status === 'ACTIVE' ? (
            <button
              type="button"
              disabled={disabled || isSelf}
              onClick={() => void run('deactivate', {})}
              className={`${buttonClass.danger} self-start whitespace-nowrap`}
            >
              {t.deactivate}
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run('reactivate', {})}
              className={`${buttonClass.secondary} self-start whitespace-nowrap`}
            >
              {t.reactivate}
            </button>
          )}
        </section>
      </div>
    </Card>
  );
}
