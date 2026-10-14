import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createE2eStorage,
  POINTER_MARKER,
  POINTER_SUFFIX,
  pointerViolation,
} from '../scripts/e2e-storage.mjs';

/**
 * The e2e API's file storage (PR #21 review): never deletes anything, never uses a caller-supplied
 * path as storage, and writes only a validated pointer file. Everything runs in a fresh sandbox;
 * real directories (/, home, repository) are only checked, never written.
 */
describe('e2e file storage helper', () => {
  let sandbox: string;
  let root: string;
  const created = () => readdirSync(root);

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ayvo-e2e-storage-test-'));
    root = join(sandbox, 'tmp-root');
    mkdirSync(root);
  });

  it('refuses a directory (with unrelated content) given as pointer and preserves it', () => {
    const dir = join(sandbox, `data${POINTER_SUFFIX}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'sentinel.txt'), 'keep me');
    expect(() => createE2eStorage(dir, { root })).toThrow(/not a regular file/);
    expect(readFileSync(join(dir, 'sentinel.txt'), 'utf8')).toBe('keep me');
    expect(created()).toEqual([]);
  });

  it('refuses an existing file that is not a pointer and leaves its content', () => {
    const file = join(sandbox, `notes${POINTER_SUFFIX}`);
    writeFileSync(file, 'important unrelated content');
    expect(() => createE2eStorage(file, { root })).toThrow(/not a pointer file/);
    expect(readFileSync(file, 'utf8')).toBe('important unrelated content');
    expect(created()).toEqual([]);
  });

  it('refuses symbolic links — as the pointer and as its directory', () => {
    const target = join(sandbox, 'target.txt');
    writeFileSync(target, 'sentinel');
    const link = join(sandbox, `link${POINTER_SUFFIX}`);
    symlinkSync(target, link);
    expect(() => createE2eStorage(link, { root })).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('sentinel');

    const realDir = join(sandbox, 'real');
    mkdirSync(realDir);
    symlinkSync(realDir, join(sandbox, 'linked-dir'));
    expect(() =>
      createE2eStorage(join(sandbox, 'linked-dir', `p${POINTER_SUFFIX}`), { root }),
    ).toThrow(/not a real directory/);
    expect(readdirSync(realDir)).toEqual([]);
    expect(created()).toEqual([]);
  });

  it('refuses root, home, the repository and other paths without the pointer suffix', () => {
    const repo = resolve(import.meta.dirname, '../../..');
    for (const path of [
      '/',
      homedir(),
      repo,
      sandbox,
      join(sandbox, 'x.txt'),
      `relative${POINTER_SUFFIX}`,
    ]) {
      expect(pointerViolation(path), path).not.toBeNull();
    }
    expect(pointerViolation(join(sandbox, POINTER_SUFFIX))).not.toBeNull();
    expect(pointerViolation(join(sandbox, 'missing', `p${POINTER_SUFFIX}`))).toMatch(
      /does not exist/,
    );
    expect(existsSync(repo)).toBe(true);
  });

  it('creates a fresh directory and records it; a later run never deletes the earlier one', () => {
    const pointer = join(sandbox, `run${POINTER_SUFFIX}`);
    const first = createE2eStorage(pointer, { root });
    expect(first.startsWith(join(root, 'ayvo-e2e-files-'))).toBe(true);
    expect(readFileSync(pointer, 'utf8')).toBe(`${POINTER_MARKER}\n${first}\n`);
    writeFileSync(join(first, 'object.pdf'), 'stored');

    const second = createE2eStorage(pointer, { root });
    expect(second).not.toBe(first);
    expect(readFileSync(pointer, 'utf8')).toBe(`${POINTER_MARKER}\n${second}\n`);
    expect(readFileSync(join(first, 'object.pdf'), 'utf8')).toBe('stored');
    expect(created()).toHaveLength(2);
    expect(createE2eStorage(undefined, { root }).startsWith(root)).toBe(true);
  });
});
