'use client';

import {
  adminUserDetailSchema,
  isPlannedRole,
  type AssignableSites,
  type PermissionCode,
  type RoleCatalog,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { AccessPreview } from './access-preview';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

export function errorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code && t.errors[error.code])
    return t.errors[error.code]!;
  return error instanceof Error ? error.message : 'Akce se nezdařila.';
}

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * Creates a pre-provisioned user (access starts when the person signs in with this e-mail):
 * 1. roles — what the user may do; 2. sites — where; 3. optionally narrower warehouses. The
 * preview applies the same rules as the server, which evaluates them again on every request.
 */
export function CreateUserForm({ roles, sites }: { roles: RoleCatalog; sites: AssignableSites }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedRoles, setRoles] = useState<string[]>([]);
  const [selectedSites, setSites] = useState<string[]>([]);
  const [selectedWarehouses, setWarehouses] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Planned system roles are shown, disabled, but never selectable (doc 021 §4c).
  const grantable = roles.filter((r) => r.active && !isPlannedRole(r.code));
  const planned = roles.filter((r) => isPlannedRole(r.code));
  const permissions = [
    ...new Set(
      grantable.filter((r) => selectedRoles.includes(r.code)).flatMap((r) => r.permissions),
    ),
  ].sort() as PermissionCode[];
  const global = permissions.includes('sites:all_access');
  const previewSites = (global ? sites : sites.filter((s) => selectedSites.includes(s.id))).map(
    (s) => {
      const own = global ? [] : s.warehouses.filter((w) => selectedWarehouses.includes(w.code));
      return { ...s, allWarehouses: own.length === 0, warehouses: own.length ? own : s.warehouses };
    },
  );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <form
          className="flex max-w-2xl flex-col gap-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const user = await apiSend('POST', 'admin/identity/users', adminUserDetailSchema, {
                email,
                displayName,
                roles: selectedRoles,
                siteIds: selectedSites,
                warehouseCodes: selectedWarehouses,
                reason,
              });
              router.push(`/admin/users/${user.id}`);
            } catch (err) {
              setError(errorText(err));
              setBusy(false);
            }
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.email}</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.name}</span>
              <input
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className={label}>1. {t.roles}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {grantable.map((r) => (
                <label key={r.code} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedRoles.includes(r.code)}
                    onChange={() => setRoles((l) => toggle(l, r.code))}
                  />
                  <span className="min-w-0 wrap-anywhere">
                    {r.name}
                    {!r.system && (
                      <span className="ml-1 text-xs text-stone-500">({t.customRole})</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-stone-500">{t.roleHelp}</p>
            {planned.length > 0 && <PlannedRoles roles={planned} />}
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className={label}>2. {t.sites}</legend>
            <p className="text-xs text-stone-500">{t.sitesHelp}</p>
            {sites.map((s) => (
              <div key={s.id} className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedSites.includes(s.id)}
                    onChange={() => {
                      setSites((l) => toggle(l, s.id));
                      // Leaving a site also drops its narrower warehouses.
                      setWarehouses((l) =>
                        l.filter((code) => !s.warehouses.some((w) => w.code === code)),
                      );
                    }}
                  />
                  <span className="wrap-anywhere">
                    {s.name} <span className="font-mono text-xs text-stone-500">{s.code}</span>
                    {!s.active && (
                      <span className="ml-1 text-xs text-amber-800">
                        ({identityCs.shell.inactiveSite})
                      </span>
                    )}
                  </span>
                </label>
                {selectedSites.includes(s.id) && s.warehouses.length > 1 && (
                  <fieldset className="ml-6 flex flex-col gap-1">
                    <legend className="text-xs text-stone-500">3. {t.narrowWarehouses}</legend>
                    {s.warehouses.map((w) => (
                      <label key={w.code} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedWarehouses.includes(w.code)}
                          onChange={() => setWarehouses((l) => toggle(l, w.code))}
                        />
                        {w.name} <span className="font-mono text-xs text-stone-500">{w.code}</span>
                      </label>
                    ))}
                    <p className="text-xs text-stone-500">{t.narrowHelp}</p>
                  </fieldset>
                )}
              </div>
            ))}
          </fieldset>
          <p className="text-xs text-stone-500">{t.invitationHelp}</p>
          <label className="flex flex-col gap-1">
            <span className={label}>{t.reason}</span>
            <input
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t.reasonPlaceholder}
              className={inputClass}
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div>
            <button type="submit" disabled={busy} className={buttonClass.primary}>
              {busy ? t.saving : t.save}
            </button>
          </div>
        </form>
      </Card>
      <Card title={t.effective}>
        <p className="mb-3 text-xs text-stone-500">{t.effectiveHelp}</p>
        <AccessPreview
          permissions={permissions}
          sites={previewSites}
          global={global}
          testId="access-preview"
        />
      </Card>
    </div>
  );
}

/** Planned system roles: visible, disabled, labelled "Připravuje se" with what each will be. */
export function PlannedRoles({ roles }: { roles: RoleCatalog }) {
  const p = identityCs.planned;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="planned-roles">
      <p className={label}>{p.section}</p>
      {roles.map((r) => (
        <label
          key={r.code}
          className="flex items-start gap-2 text-sm text-stone-400"
          data-planned-role={r.code}
        >
          <input type="checkbox" className="mt-0.5" disabled checked={false} readOnly />
          <span className="min-w-0 wrap-anywhere">
            {r.name}{' '}
            <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
              {p.label}
            </span>
            <span className="block text-xs text-stone-500">{p.roles[r.code] ?? p.help}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-stone-500">{p.help}</p>
    </div>
  );
}
