'use client';

import {
  PERMISSION_MODULES,
  roleDetailSchema,
  type PermissionCatalog,
  type PermissionCode,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.roles_admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Creates or edits a custom role: name, description and permissions chosen by checkbox, grouped
 * by module. Security-administration permissions are shown but cannot be chosen (only the ADMIN
 * system role holds them). Saving needs a reason; the change is audited and applies to every
 * holder on their next request.
 */
export function RoleForm({
  catalogue,
  role,
  initial,
}: {
  catalogue: PermissionCatalog;
  /** The custom role being edited; absent when creating. */
  role?: { id: string; code: string };
  initial: {
    name: string;
    description: string;
    permissions: readonly PermissionCode[];
    copiedFrom: string | null;
  };
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [selected, setSelected] = useState<PermissionCode[]>(
    initial.permissions.filter((p) => !catalogue.find((c) => c.code === p)?.securityAdmin),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = PERMISSION_MODULES.map((module) => ({
    module,
    permissions: catalogue.filter((p) => p.module === module),
  })).filter((g) => g.permissions.length > 0);

  return (
    <Card>
      <form
        className="flex max-w-3xl flex-col gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const saved = role
              ? await apiSend('POST', `admin/identity/roles/${role.id}`, roleDetailSchema, {
                  name,
                  description,
                  permissions: selected,
                  reason,
                })
              : await apiSend('POST', 'admin/identity/roles', roleDetailSchema, {
                  code,
                  name,
                  description,
                  permissions: selected,
                  copiedFrom: initial.copiedFrom,
                  reason,
                });
            router.push(`/admin/roles/${saved.id}`);
            router.refresh();
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!role && (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.code}</span>
              <input
                required
                pattern="[A-Z][A-Z0-9_]{2,39}"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className={`${inputClass} font-mono`}
              />
            </label>
          )}
          <label className="flex min-w-0 flex-col gap-1">
            <span className={label}>{t.name}</span>
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className={label}>{t.description}</span>
          <textarea
            maxLength={500}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </label>
        <fieldset className="flex flex-col gap-4" data-testid="role-permissions">
          <legend className={label}>{t.permissions}</legend>
          {groups.map((g) => (
            <fieldset key={g.module} className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{identityCs.modules[g.module]}</legend>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {g.permissions.map((p) => (
                  <label
                    key={p.code}
                    className={`flex items-start gap-2 text-sm ${p.securityAdmin ? 'text-stone-400' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      disabled={p.securityAdmin}
                      checked={selected.includes(p.code)}
                      onChange={() =>
                        setSelected((l) =>
                          l.includes(p.code) ? l.filter((x) => x !== p.code) : [...l, p.code],
                        )
                      }
                    />
                    <span className="min-w-0 wrap-anywhere">
                      {identityCs.permissions[p.code] ?? p.code}
                      <span className="block font-mono text-[11px] text-stone-400">
                        {p.code}
                        {p.warehouseScoped ? ` · ${t.scoped}` : ''}
                        {p.securityAdmin ? ` · ${t.reserved}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className={label}>{identityCs.admin.reason}</span>
          <input
            required
            minLength={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={identityCs.admin.reasonPlaceholder}
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

/** Deactivates (only when nobody holds it) or reactivates a custom role, with a reason. */
export function RoleStatus({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2" data-testid="role-status">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={identityCs.admin.reasonPlaceholder}
        aria-label={identityCs.admin.reason}
        className={inputClass}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="button"
        disabled={busy || reason.trim().length < 3}
        className={`${active ? buttonClass.danger : buttonClass.secondary} self-start whitespace-nowrap`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiSend(
              'POST',
              `admin/identity/roles/${id}/${active ? 'deactivate' : 'reactivate'}`,
              roleDetailSchema,
              { reason },
            );
            setReason('');
            router.refresh();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {active ? t.deactivate : t.reactivate}
      </button>
    </div>
  );
}
