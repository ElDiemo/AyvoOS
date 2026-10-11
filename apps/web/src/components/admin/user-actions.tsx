'use client';

import { adminUserDetailSchema, type AdminUserDetail, type RoleCatalog } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Role, warehouse and status changes of one user. One shared, required reason field: every
 * change is audited with it and applies to the user's next request.
 */
export function UserActions({
  user,
  roles,
  warehouses,
  isSelf,
}: {
  user: AdminUserDetail;
  roles: RoleCatalog;
  warehouses: { code: string; name: string }[];
  isSelf: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [role, setRole] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonOk = reason.trim().length >= 3;
  const missingRoles = roles.filter((r) => !user.roles.includes(r.code));
  const scopedCodes = user.scopes.flatMap((s) => (s.locationCode ? [s.locationCode] : []));
  const missingWarehouses = warehouses.filter((w) => !scopedCodes.includes(w.code));

  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', `admin/identity/users/${user.id}/${path}`, adminUserDetailSchema, {
        ...body,
        reason,
      });
      setReason('');
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
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
              <li
                key={r}
                className="flex items-center gap-2 rounded-full bg-stone-100 py-1 pr-1 pl-3 text-sm"
              >
                {identityCs.roles[r] ?? r}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('roles/revoke', { role: r })}
                  className="rounded-full px-2 py-0.5 text-xs text-red-800 hover:bg-red-50 disabled:opacity-40"
                  aria-label={`${t.revoke}: ${identityCs.roles[r] ?? r}`}
                >
                  {t.revoke}
                </button>
              </li>
            ))}
          </ul>
          {missingRoles.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                aria-label={t.roles}
                className={inputClass}
              >
                <option value="">—</option>
                {missingRoles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {identityCs.roles[r.code] ?? r.code}
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
          <h3 className={label}>{t.warehouses}</h3>
          <ul className="flex flex-wrap gap-2">
            {scopedCodes.length === 0 && (
              <li className="text-sm text-stone-500">{t.noWarehouses}</li>
            )}
            {scopedCodes.map((code) => (
              <li
                key={code}
                className="flex items-center gap-2 rounded-full bg-stone-100 py-1 pr-1 pl-3 font-mono text-sm"
              >
                {code}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void run('warehouses/revoke', { warehouseCode: code })}
                  className="rounded-full px-2 py-0.5 font-sans text-xs text-red-800 hover:bg-red-50 disabled:opacity-40"
                >
                  {t.revoke}
                </button>
              </li>
            ))}
          </ul>
          {missingWarehouses.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
                aria-label={t.warehouses}
                className={inputClass}
              >
                <option value="">—</option>
                {missingWarehouses.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.name} ({w.code})
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
