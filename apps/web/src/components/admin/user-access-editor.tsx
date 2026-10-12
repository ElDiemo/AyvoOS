'use client';

import {
  adminUserDetailSchema,
  isPlannedRole,
  type AdminUserDetail,
  type AssignableSites,
  type PermissionCode,
  type RoleCatalog,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useRef, useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import {
  accessChanges,
  blockingReason,
  draftFromUser,
  setNarrowed,
  toggleRole,
  toggleSite,
  toggleWarehouse,
  type AccessDraft,
} from '@/lib/access-draft';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { AccessPreview } from './access-preview';
import { errorText, PlannedRoles } from './create-user-form';

const t = identityCs.admin.access;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

function Mark({ current, chosen }: { current: boolean; chosen: boolean }) {
  if (current && chosen) return <span className="ml-1 text-xs text-stone-500">({t.current})</span>;
  if (current)
    return <span className="ml-1 text-xs font-medium text-red-800">({t.willRemove})</span>;
  if (chosen)
    return <span className="ml-1 text-xs font-medium text-emerald-800">({t.willAdd})</span>;
  return null;
}

function ChangeList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="list-disc pl-5">
        {items.map((i) => (
          <li key={i} className="wrap-anywhere">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One form for a user's whole access (doc 021 §7): roles, sites and narrower warehouses are
 * edited as a draft, summarised in Czech and saved with one button and one reason — atomically on
 * the server. Nothing is silently disabled: what prevents saving is written next to the button.
 */
export function UserAccessEditor({
  user,
  roles,
  sites,
}: {
  user: AdminUserDetail;
  roles: RoleCatalog;
  sites: AssignableSites;
}) {
  const router = useRouter();
  const ids = useId();
  const reasonRef = useRef<HTMLInputElement>(null);
  const initial = useMemo(() => draftFromUser(user, sites), [user, sites]);
  const [draft, setDraft] = useState<AccessDraft>(initial);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (next: AccessDraft) => {
    setDraft(next);
    setRequestId(null);
    setError(null);
  };
  const changes = accessChanges(initial, draft, roles, sites);
  const blocked = blockingReason(changes, draft, sites, reason, attempted);

  // Selectable: active, non-planned roles plus everything the user holds now (to remove it).
  const selectable = roles.filter(
    (r) => initial.roles.includes(r.code) || (r.active && !isPlannedRole(r.code)),
  );
  const planned = roles.filter((r) => isPlannedRole(r.code) && !initial.roles.includes(r.code));
  const permissions = [
    ...new Set(roles.filter((r) => draft.roles.includes(r.code)).flatMap((r) => r.permissions)),
  ].sort() as PermissionCode[];
  const global = permissions.includes('sites:all_access');
  const previewSites = (global ? sites : sites.filter((s) => draft.siteIds.includes(s.id))).map(
    (s) => {
      const own = global ? [] : s.warehouses.filter((w) => draft.warehouseCodes.includes(w.code));
      return { ...s, allWarehouses: own.length === 0, warehouses: own.length ? own : s.warehouses };
    },
  );

  async function save() {
    setAttempted(true);
    setError(null);
    if (blockingReason(changes, draft, sites, reason, true)) {
      if (!changes.empty && reason.trim().length < 3) reasonRef.current?.focus();
      return;
    }
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setBusy(true);
    try {
      await apiSend('POST', `admin/identity/users/${user.id}/access`, adminUserDetailSchema, {
        requestId: id,
        roles: draft.roles,
        siteIds: draft.siteIds,
        warehouseCodes: draft.warehouseCodes,
        reason,
      });
      setReason('');
      setAttempted(false);
      setRequestId(null);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
      // A definite answer ends the attempt; a network error keeps the id for a safe retry.
      if (err instanceof ClientApiError) setRequestId(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t.title}>
      <form
        className="flex flex-col gap-6"
        data-testid="access-editor"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-stone-600">{t.help}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className={label}>1. {identityCs.admin.roles}</legend>
          {selectable.map((r) => (
            <label key={r.code} className="flex items-start gap-2 text-sm" data-role={r.code}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={draft.roles.includes(r.code)}
                onChange={() => edit(toggleRole(draft, r.code))}
              />
              <span className="min-w-0 wrap-anywhere">
                {r.name}
                {!r.system && (
                  <span className="ml-1 text-xs text-stone-500">
                    ({identityCs.admin.customRole})
                  </span>
                )}
                {isPlannedRole(r.code) && (
                  <span className="ml-1 text-xs text-stone-500">({identityCs.planned.label})</span>
                )}
                <Mark
                  current={initial.roles.includes(r.code)}
                  chosen={draft.roles.includes(r.code)}
                />
              </span>
            </label>
          ))}
          {planned.length > 0 && <PlannedRoles roles={planned} />}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className={label}>2. {identityCs.admin.sites}</legend>
          {global && <p className="text-xs text-stone-500">{t.globalAccess}</p>}
          {sites.map((s) => {
            const chosen = draft.siteIds.includes(s.id);
            const narrowedNow = draft.narrowed.includes(s.id);
            const showNarrowing =
              chosen &&
              (s.warehouses.length > 1 ||
                s.warehouses.some((w) => initial.warehouseCodes.includes(w.code)));
            return (
              <div key={s.id} className="flex flex-col gap-2" data-access-site={s.code}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={chosen}
                    onChange={() => edit(toggleSite(draft, s))}
                  />
                  <span className="min-w-0 wrap-anywhere">
                    {s.name} <span className="font-mono text-xs text-stone-500">{s.code}</span>
                    {!s.active && (
                      <span className="ml-1 text-xs text-amber-800">
                        ({identityCs.shell.inactiveSite})
                      </span>
                    )}
                    <Mark current={initial.siteIds.includes(s.id)} chosen={chosen} />
                    {chosen && !showNarrowing && (
                      <span className="block text-xs text-stone-500">
                        {s.warehouses.length === 0
                          ? t.noWarehouse
                          : t.allWarehousesOf(s.warehouses.map((w) => w.code).join(', '))}
                      </span>
                    )}
                  </span>
                </label>
                {showNarrowing && (
                  <fieldset className="ml-6 flex flex-col gap-1">
                    <legend className="text-xs text-stone-500">3. {t.warehousesOf(s.name)}</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`${ids}-${s.id}`}
                        checked={!narrowedNow}
                        onChange={() => edit(setNarrowed(draft, s, false))}
                      />
                      {t.allWarehouses}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`${ids}-${s.id}`}
                        checked={narrowedNow}
                        onChange={() => edit(setNarrowed(draft, s, true))}
                      />
                      {t.onlyChosen}
                    </label>
                    {narrowedNow &&
                      s.warehouses.map((w) => (
                        <label key={w.code} className="ml-6 flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={draft.warehouseCodes.includes(w.code)}
                            onChange={() => edit(toggleWarehouse(draft, w.code))}
                          />
                          <span className="min-w-0 wrap-anywhere">
                            {w.name}{' '}
                            <span className="font-mono text-xs text-stone-500">{w.code}</span>
                            <Mark
                              current={initial.warehouseCodes.includes(w.code)}
                              chosen={draft.warehouseCodes.includes(w.code)}
                            />
                          </span>
                        </label>
                      ))}
                  </fieldset>
                )}
              </div>
            );
          })}
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className={label}>{t.preview}</p>
          <AccessPreview
            permissions={permissions}
            sites={previewSites}
            global={global}
            testId="access-editor-preview"
          />
        </div>

        <section
          className="flex flex-col gap-2 rounded-md bg-stone-50 p-3 text-sm"
          aria-labelledby={`${ids}-summary`}
          data-testid="access-summary"
        >
          <h3 id={`${ids}-summary`} className={label}>
            {t.summary}
          </h3>
          {changes.empty ? (
            <p className="text-stone-500">{t.noChanges}</p>
          ) : (
            <>
              <ChangeList title={t.addRoles} items={changes.added.roles} />
              <ChangeList title={t.addSites} items={changes.added.sites} />
              <ChangeList title={t.addWarehouses} items={changes.added.warehouses} />
              <ChangeList title={t.removeRoles} items={changes.removed.roles} />
              <ChangeList title={t.removeSites} items={changes.removed.sites} />
              <ChangeList title={t.removeWarehouses} items={changes.removed.warehouses} />
            </>
          )}
        </section>

        <label className="flex flex-col gap-1">
          <span className={label}>{t.reason}</span>
          <input
            ref={reasonRef}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setRequestId(null);
            }}
            placeholder={identityCs.admin.reasonPlaceholder}
            aria-invalid={attempted && reason.trim().length < 3}
            aria-describedby={`${ids}-status`}
            className={inputClass}
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? t.saving : t.save}
          </button>
          {!changes.empty && (
            <button
              type="button"
              disabled={busy}
              className={buttonClass.secondary}
              onClick={() => {
                edit(initial);
                setAttempted(false);
              }}
            >
              {t.reset}
            </button>
          )}
          <p
            id={`${ids}-status`}
            role="status"
            className="min-w-0 text-sm wrap-anywhere text-stone-600"
            data-testid="access-status"
          >
            {blocked}
          </p>
        </div>
      </form>
    </Card>
  );
}
