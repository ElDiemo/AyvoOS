/**
 * This tab's stored state across a change of the active site. Everything is cleared (nothing of
 * the previous site stays on screen: station queues, picking attempts, drafts), except state that
 * is already keyed by the user AND the site and is only ever restored for exactly those: the
 * unsent "Po mytí" scans (`afterWashStorageKey`), which a sign-in followed by the site choice must
 * not lose (review 5812926955).
 */
export const AFTER_WASH_STORAGE_PREFIX = 'ayvo:after-wash:';

/** The key of the unsent "Po mytí" scans of this user at this site. */
export function afterWashStorageKey(userId: string, siteId: string | null): string {
  return `${AFTER_WASH_STORAGE_PREFIX}${userId}:${siteId ?? 'none'}`;
}

const KEPT_ACROSS_SITES = [AFTER_WASH_STORAGE_PREFIX];

/** Clears the tab's storage for a new active site, keeping only user-and-site keyed state. */
export function clearForSiteChange(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>) {
  const drop: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && !KEPT_ACROSS_SITES.some((prefix) => key.startsWith(prefix))) drop.push(key);
  }
  for (const key of drop) storage.removeItem(key);
}
