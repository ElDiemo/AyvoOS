// File storage of the e2e API (apps/web/playwright.config.ts). NOTHING IS EVER DELETED here:
// every run gets a fresh, uniquely named directory under the OS temp directory (mkdtemp), and a
// caller-supplied path is never used as the storage itself. A spec that must find the directory
// (to simulate a read-only disk) names a POINTER file; only that small file is written, and only
// after strict checks — so a mistyped variable can never point the API, or a cleanup, at real data.
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** A pointer file must carry this exact suffix (no other file can be mistaken for one). */
export const POINTER_SUFFIX = '.e2e-storage-dir';
/** First line of every pointer file: an existing file without it is never overwritten. */
export const POINTER_MARKER = '# ayvo e2e file storage pointer';

/** Why `pointer` may not be (over)written, or null if it may. Reads only; changes nothing. */
export function pointerViolation(pointer) {
  if (!isAbsolute(pointer)) return 'must be an absolute path';
  if (!basename(pointer).endsWith(POINTER_SUFFIX) || basename(pointer) === POINTER_SUFFIX) {
    return `file name must end with ${POINTER_SUFFIX}`;
  }
  let parent;
  try {
    parent = lstatSync(dirname(pointer));
  } catch {
    return 'its directory does not exist';
  }
  if (!parent.isDirectory() || parent.isSymbolicLink())
    return 'its directory is not a real directory';
  let current;
  try {
    current = lstatSync(pointer);
  } catch {
    return null; // a new pointer file
  }
  if (current.isSymbolicLink()) return 'is a symbolic link';
  if (!current.isFile()) return 'exists and is not a regular file';
  if (current.size > 4096) return 'exists and is not a pointer file';
  return null;
}

/**
 * Creates the storage directory of this run and, if asked, records its path in the pointer
 * file. Throws before creating anything when the pointer is not acceptable.
 */
export function createE2eStorage(pointer, { root = tmpdir() } = {}) {
  if (pointer) {
    const violation = pointerViolation(pointer);
    if (violation) throw new Error(`E2E_FILE_STORAGE_POINTER ${violation}: ${pointer}`);
    let existing = null;
    try {
      existing = readFileSync(pointer, 'utf8');
    } catch {
      existing = null; // a new pointer file
    }
    if (existing !== null && !existing.startsWith(POINTER_MARKER)) {
      throw new Error(`E2E_FILE_STORAGE_POINTER exists and is not a pointer file: ${pointer}`);
    }
  }
  const dir = mkdtempSync(join(root, 'ayvo-e2e-files-'));
  if (pointer) writeFileSync(pointer, `${POINTER_MARKER}\n${dir}\n`, { mode: 0o600 });
  return dir;
}
