'use client';

import { adminUserDetailSchema, type RoleCatalog } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

export function errorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code && t.errors[error.code])
    return t.errors[error.code]!;
  return error instanceof Error ? error.message : 'Akce se nezdařila.';
}

/** Creates a pre-provisioned user; access starts when the person signs in with this e-mail. */
export function CreateUserForm({
  roles,
  warehouses,
}: {
  roles: RoleCatalog;
  warehouses: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedRoles, setRoles] = useState<string[]>([]);
  const [selectedWarehouses, setWarehouses] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
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
          <legend className={label}>{t.roles}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <label key={r.code} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selectedRoles.includes(r.code)}
                  onChange={() => setRoles((l) => toggle(l, r.code))}
                />
                <span>{identityCs.roles[r.code] ?? r.code}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-stone-500">{t.roleHelp}</p>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className={label}>{t.warehouses}</legend>
          {warehouses.map((w) => (
            <label key={w.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedWarehouses.includes(w.code)}
                onChange={() => setWarehouses((l) => toggle(l, w.code))}
              />
              {w.name} <span className="font-mono text-xs text-stone-500">{w.code}</span>
            </label>
          ))}
        </fieldset>
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
  );
}
