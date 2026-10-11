import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  STORAGE_KEY_PATTERN,
  StorageObjectNotFoundError,
  type FileStorage,
} from './file-storage.js';

/**
 * FileStorage on a local directory (DEV: a persistent Docker volume, never the container layer).
 * Writes are atomic: data goes to a temporary file that is then hard-linked to its final name,
 * which also refuses to overwrite an existing object.
 */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o750 });
    const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o640 });
      // link() fails if the target exists: stored objects are never overwritten.
      await link(temp, target);
    } finally {
      // Always remove the temporary name (after success, or a failed/partial write).
      await unlink(temp).catch(() => undefined);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new StorageObjectNotFoundError();
      throw error;
    }
  }

  /** Maps a key to a path strictly inside the root (defence in depth against path traversal). */
  private pathFor(key: string): string {
    if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return path;
  }
}
