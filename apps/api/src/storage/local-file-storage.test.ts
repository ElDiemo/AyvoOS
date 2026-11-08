import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  newStorageKey,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
} from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ayvo-storage-'));
    storage = new LocalFileStorage(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('stores and reads back an object under a server-generated key', async () => {
    const key = newStorageKey('label-artworks', 'png', new Date('2026-10-10T00:00:00Z'));
    expect(key).toMatch(/^label-artworks\/2026\/10\/[0-9a-f-]{36}\.png$/);
    await storage.put(key, Buffer.from('hello'));
    expect((await storage.get(key)).toString()).toBe('hello');
    // No temporary files are left behind.
    expect(await readdir(join(root, 'label-artworks/2026/10'))).toEqual([key.split('/').pop()]);
  });

  it('never overwrites an existing object, and cleans up the temporary file of the failed write', async () => {
    const key = newStorageKey('label-print-jobs', 'pdf');
    await storage.put(key, Buffer.from('first'));
    await expect(storage.put(key, Buffer.from('second'))).rejects.toThrow();
    expect((await storage.get(key)).toString()).toBe('first');
    const dir = join(root, key.split('/').slice(0, -1).join('/'));
    expect(await readdir(dir)).toEqual([key.split('/').pop()]);
  });

  it('reports a missing object without leaking its path', async () => {
    const key = newStorageKey('label-print-jobs', 'pdf');
    const error = await storage.get(key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageObjectNotFoundError);
    expect(String(error)).not.toContain(root);
  });

  it.each([
    '../etc/passwd',
    'label-artworks/../../x.png',
    '/abs/path.png',
    'label-artworks/2026/10/x.png',
  ])('rejects key %s (path traversal / non-generated keys)', async (key) => {
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(storage.get(key)).rejects.toThrow('Invalid storage key');
  });

  it('a bounded read: within the limit, refused beyond it before reading, stopped by its signal', async () => {
    const key = newStorageKey('finance-documents', 'pdf');
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    await storage.put(key, bytes);
    const open = { signal: new AbortController().signal };
    expect(await storage.getBounded(key, { ...open, maxBytes: bytes.length })).toEqual(bytes);
    await expect(storage.getBounded(key, { ...open, maxBytes: 1024 })).rejects.toBeInstanceOf(
      StorageObjectTooLargeError,
    );
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(
      storage.getBounded(key, { signal: stop.signal, maxBytes: bytes.length }),
    ).rejects.toThrow('stopped');
    await expect(
      storage.getBounded(newStorageKey('finance-documents', 'pdf'), { ...open, maxBytes: 1 }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});
