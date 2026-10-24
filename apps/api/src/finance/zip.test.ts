import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildZip } from './zip.js';

/** The archive is checked by an independent reader (Python's zipfile, CRC verified). */
function readWithPython(zip: Buffer): { name: string; size: number; text?: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-zip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, zip);
  const res = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      [
        'import json, sys, zipfile',
        'z = zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None',
        'print(json.dumps([{"name": i.filename, "size": i.file_size, "text": z.read(i).decode("utf-8", "replace")} for i in z.infolist()]))',
      ].join('\n'),
      file,
    ],
    { encoding: 'utf8' },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

describe('buildZip', () => {
  it('writes an archive a standard reader opens, with UTF-8 names and exact contents', () => {
    const zip = buildZip([
      { name: 'manifest.csv', data: Buffer.from('﻿kód;částka\r\nFD-000001;25000.00\r\n') },
      { name: 'doklady/FD-000001-Nájem.pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') },
      { name: 'prázdný.txt', data: Buffer.alloc(0) },
    ]);
    const entries = readWithPython(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.csv',
      'doklady/FD-000001-Nájem.pdf',
      'prázdný.txt',
    ]);
    expect(entries[0]!.text).toContain('FD-000001;25000.00');
    expect(entries[1]!.text).toBe('%PDF-1.4\n%%EOF\n');
    expect(entries[2]!.size).toBe(0);
  });

  it('refuses unsafe or duplicate names', () => {
    for (const name of ['../x', '/abs', 'a/../b', ''])
      expect(() => buildZip([{ name, data: Buffer.from('x') }])).toThrow(/Unsafe/);
    expect(() =>
      buildZip([
        { name: 'a', data: Buffer.from('1') },
        { name: 'a', data: Buffer.from('2') },
      ]),
    ).toThrow(/Duplicate/);
  });
});
