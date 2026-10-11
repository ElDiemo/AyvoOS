/**
 * The source lot the operator selected for this label-application session (doc 018 §10). Kept
 * per browser tab (sessionStorage) so a refresh keeps it; it changes only by an explicit operator
 * action — never automatically. Storage may be unavailable; every access is guarded.
 */
export interface ActiveLot {
  id: string;
  code: string;
}

const KEY = 'ayvo.warehouse.activeLot';
const listeners = new Set<() => void>();

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function parseActiveLot(raw: string | null): ActiveLot | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as ActiveLot).id === 'string' &&
      typeof (value as ActiveLot).code === 'string'
    ) {
      return { id: (value as ActiveLot).id, code: (value as ActiveLot).code };
    }
  } catch {
    // corrupt entry: none
  }
  return null;
}

export function subscribeActiveLot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Raw stored string: a stable snapshot for useSyncExternalStore. */
export function activeLotSnapshot(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function setActiveLot(lot: ActiveLot | null, store = storage()): void {
  try {
    if (lot) store?.setItem(KEY, JSON.stringify(lot));
    else store?.removeItem(KEY);
  } catch {
    // without storage the selection lasts until the page is left
  }
  listeners.forEach((l) => l());
}
