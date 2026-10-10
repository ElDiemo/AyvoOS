import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newStorageKey, StorageObjectNotFoundError } from './file-storage.js';
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
});
