/**
 * The bottle registration a user has confirmed but whose outcome the page has not seen yet.
 * Kept in sessionStorage (this tab only) so that a refresh or a lost response is retried with the
 * SAME idempotency key: the server then returns the original result instead of creating a second
 * set of bottles. Cleared once the result has been shown. Storage may be unavailable (private
 * mode, blocked site data): every access is guarded and the page works without it.
 */
export interface PendingRegistration {
  requestId: string;
  labelTemplateVersionId: string;
  quantity: number;
}

const KEY = 'ayvo.pendingBottleRegistration';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPendingRegistration(store = storage()): PendingRegistration | null {
  try {
    return parsePendingRegistration(store?.getItem(KEY) ?? null);
  } catch {
    return null;
  }
}

/** Parses a stored entry; null for no, corrupt or incomplete entries. */
export function parsePendingRegistration(raw: string | null): PendingRegistration | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as PendingRegistration).requestId === 'string' &&
      typeof (value as PendingRegistration).labelTemplateVersionId === 'string' &&
      Number.isInteger((value as PendingRegistration).quantity)
    ) {
      const { requestId, labelTemplateVersionId, quantity } = value as PendingRegistration;
      return { requestId, labelTemplateVersionId, quantity };
    }
  } catch {
    // Corrupt entry: behave as if there were none.
  }
  return null;
}

// --- external store for useSyncExternalStore (the raw string is a stable snapshot) ------------

const listeners = new Set<() => void>();

export function subscribePendingRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingRegistrationSnapshot(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function savePendingRegistration(pending: PendingRegistration, store = storage()): void {
  try {
    store?.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Without storage, retries within the page still reuse the key; only a refresh cannot.
  }
  listeners.forEach((listener) => listener());
}

export function clearPendingRegistration(store = storage()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing to clean up.
  }
  listeners.forEach((listener) => listener());
}
