/**
 * A choice the operator makes once per working session (doc 018 §10, doc 019): kept per browser
 * tab (sessionStorage) so a refresh keeps it; it changes only by an explicit operator action —
 * never automatically. Storage may be unavailable; every access is guarded.
 */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function createSessionChoice<T>(key: string, isValid: (value: unknown) => value is T) {
  const listeners = new Set<() => void>();
  return {
    key,
    parse(raw: string | null): T | null {
      try {
        const value: unknown = JSON.parse(raw ?? 'null');
        if (isValid(value)) return value;
      } catch {
        // corrupt entry: none
      }
      return null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Raw stored string: a stable snapshot for useSyncExternalStore. */
    snapshot(): string | null {
      try {
        return sessionStore()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(value: T | null, store: Store | null = sessionStore()): void {
      try {
        if (value) store?.setItem(key, JSON.stringify(value));
        else store?.removeItem(key);
      } catch {
        // without storage the selection lasts until the page is left
      }
      listeners.forEach((l) => l());
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The source stock lot of a label-application session. */
export interface ActiveLot {
  id: string;
  code: string;
}

/** The bottle series (creation batch) being labelled in a label-application session. */
export interface ActiveSeries {
  code: string;
  /** Label template version and bottle range, for display only. */
  label: string;
}

export const activeLot = createSessionChoice<ActiveLot>(
  'ayvo.production.activeLot',
  (v): v is ActiveLot => isRecord(v) && typeof v.id === 'string' && typeof v.code === 'string',
);

export const activeSeries = createSessionChoice<ActiveSeries>(
  'ayvo.production.activeSeries',
  (v): v is ActiveSeries =>
    isRecord(v) && typeof v.code === 'string' && typeof v.label === 'string',
);
