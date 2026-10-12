import type { AdminUserDetail, AssignableSites, RoleCatalog } from '@ayvo/types';

/**
 * The access editor's draft (doc 021 §7): the complete new state of a user's roles, sites and
 * narrower warehouses, saved at once by `POST /api/admin/identity/users/:id/access`. Pure
 * functions, so the summary and the blocking reasons are unit-tested.
 */
export interface AccessDraft {
  roles: string[];
  siteIds: string[];
  /** Sites limited to chosen warehouses (absent: all warehouses of the site). */
  narrowed: string[];
  warehouseCodes: string[];
}

export function draftFromUser(user: AdminUserDetail, sites: AssignableSites): AccessDraft {
  const siteIds = user.scopes.filter((s) => s.type === 'SITE' && s.siteId).map((s) => s.siteId!);
  const warehouseCodes = user.scopes
    .filter((s) => s.type === 'WAREHOUSE' && s.locationCode)
    .map((s) => s.locationCode!);
  return {
    roles: user.roles.map((r) => r.code).sort(),
    siteIds: siteIds.sort(),
    narrowed: sites
      .filter((s) => s.warehouses.some((w) => warehouseCodes.includes(w.code)))
      .map((s) => s.id)
      .sort(),
    warehouseCodes: warehouseCodes.sort(),
  };
}

const toggle = (list: string[], value: string) =>
  (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]).sort();

export const toggleRole = (d: AccessDraft, code: string): AccessDraft => ({
  ...d,
  roles: toggle(d.roles, code),
});

/** Leaving a site also drops its narrowing and its warehouses. */
export function toggleSite(d: AccessDraft, site: AssignableSites[number]): AccessDraft {
  if (!d.siteIds.includes(site.id)) return { ...d, siteIds: toggle(d.siteIds, site.id) };
  const codes = site.warehouses.map((w) => w.code);
  return {
    roles: d.roles,
    siteIds: d.siteIds.filter((id) => id !== site.id),
    narrowed: d.narrowed.filter((id) => id !== site.id),
    warehouseCodes: d.warehouseCodes.filter((c) => !codes.includes(c)),
  };
}

/** "All warehouses of the site" (narrow = false) or "only chosen warehouses" (narrow = true). */
export function setNarrowed(
  d: AccessDraft,
  site: AssignableSites[number],
  narrow: boolean,
): AccessDraft {
  const codes = site.warehouses.map((w) => w.code);
  return narrow
    ? { ...d, narrowed: [...new Set([...d.narrowed, site.id])].sort() }
    : {
        ...d,
        narrowed: d.narrowed.filter((id) => id !== site.id),
        warehouseCodes: d.warehouseCodes.filter((c) => !codes.includes(c)),
      };
}

export const toggleWarehouse = (d: AccessDraft, code: string): AccessDraft => ({
  ...d,
  warehouseCodes: toggle(d.warehouseCodes, code),
});

export interface AccessChanges {
  added: { roles: string[]; sites: string[]; warehouses: string[] };
  removed: { roles: string[]; sites: string[]; warehouses: string[] };
  empty: boolean;
}

/** What saving would add and remove, in human names. */
export function accessChanges(
  before: AccessDraft,
  after: AccessDraft,
  roles: RoleCatalog,
  sites: AssignableSites,
): AccessChanges {
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const siteName = (id: string) => {
    const s = sites.find((x) => x.id === id);
    return s ? `${s.name} (${s.code})` : id;
  };
  const warehouseName = (code: string) => {
    for (const s of sites) {
      const w = s.warehouses.find((x) => x.code === code);
      if (w) return `${w.name} (${w.code}) – ${s.name}`;
    }
    return code;
  };
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const added = {
    roles: diff(after.roles, before.roles).map(roleName),
    sites: diff(after.siteIds, before.siteIds).map(siteName),
    warehouses: diff(after.warehouseCodes, before.warehouseCodes).map(warehouseName),
  };
  const removed = {
    roles: diff(before.roles, after.roles).map(roleName),
    sites: diff(before.siteIds, after.siteIds).map(siteName),
    warehouses: diff(before.warehouseCodes, after.warehouseCodes).map(warehouseName),
  };
  const empty = [...Object.values(added), ...Object.values(removed)].every((l) => l.length === 0);
  return { added, removed, empty };
}

/** Sites limited to chosen warehouses but with none chosen (cannot be saved like that). */
export function narrowedWithoutWarehouse(d: AccessDraft, sites: AssignableSites): string[] {
  return sites
    .filter((s) => d.narrowed.includes(s.id) && d.siteIds.includes(s.id))
    .filter((s) => !s.warehouses.some((w) => d.warehouseCodes.includes(w.code)))
    .map((s) => s.name);
}

export const REASON_MIN = 3;

/**
 * Why saving is not possible right now (Czech, shown next to the button), or null. The reason is
 * checked only when saving is attempted (`attempted`), never as a silent block of the controls.
 */
export function blockingReason(
  changes: AccessChanges,
  draft: AccessDraft,
  sites: AssignableSites,
  reason: string,
  attempted: boolean,
): string | null {
  if (changes.empty) return 'Nejsou žádné změny k uložení.';
  const missing = narrowedWithoutWarehouse(draft, sites);
  if (missing.length > 0) {
    return `Vyberte alespoň jeden sklad (${missing.join(', ')}), nebo zvolte všechny sklady provozovny.`;
  }
  if (attempted && reason.trim().length < REASON_MIN) {
    return `Vyplňte důvod změny (alespoň ${REASON_MIN} znaky).`;
  }
  return null;
}
