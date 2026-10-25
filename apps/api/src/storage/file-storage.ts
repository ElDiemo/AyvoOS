import { randomUUID } from 'node:crypto';

/**
 * Binary file storage (label artwork, generated print PDFs). Domain modules depend only on this
 * interface; the local filesystem implementation can be replaced by object storage (e.g. S3)
 * without touching them. Keys are opaque, server-generated and never contain user input.
 */
export interface FileStorage {
  // Deliberately no delete(): stored objects are referenced by immutable records (template
  // versions, print jobs) and must never disappear through the application.
  /** Stores a new object. Fails if the key already exists: stored objects are never replaced. */
  put(key: string, data: Uint8Array): Promise<void>;
  /** Reads an object. Throws {@link StorageObjectNotFoundError} if it does not exist. */
  get(key: string): Promise<Buffer>;
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super('Stored file not found');
  }
}

/** Safe errors: never expose SDK exceptions (which can contain signed requests or credentials). */
export class StorageObjectAlreadyExistsError extends Error {
  constructor() {
    super('Stored file already exists');
  }
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('File storage is unavailable');
  }
}

export type StorageNamespace =
  | 'label-artworks'
  | 'label-print-jobs'
  | 'supplier-documents'
  | 'shipment-labels'
  | 'employee-card-photos'
  | 'finance-documents'
  | 'accounting-exports';

/** `namespace/yyyy/mm/<uuid>.<ext>` — lowercase ASCII only, no user-controlled parts. */
export const STORAGE_KEY_PATTERN = /^[a-z0-9-]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export function newStorageKey(
  namespace: StorageNamespace,
  extension: string,
  now: Date = new Date(),
): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `${namespace}/${yyyy}/${mm}/${randomUUID()}.${extension}`;
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  return key;
}
