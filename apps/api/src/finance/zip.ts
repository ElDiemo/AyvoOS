import { crc32 } from 'node:zlib';

/**
 * A minimal ZIP writer (STORE, no compression) for the accountant export — no dependency.
 * UTF-8 names (flag 11), fixed timestamp, sizes < 4 GiB and < 65 535 entries (the export is
 * bounded far below that). Documents are already compressed formats (PDF/JPEG/PNG).
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const MAX_ENTRIES = 65_534;
const MAX_TOTAL = 0xffff_fff0;

export function buildZip(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) throw new RangeError('Too many ZIP entries');
  const names = new Set<string>();
  const time =
    ((at.getUTCHours() & 0x1f) << 11) |
    ((at.getUTCMinutes() & 0x3f) << 5) |
    (at.getUTCSeconds() >> 1);
  const date =
    (((at.getUTCFullYear() - 1980) & 0x7f) << 9) |
    (((at.getUTCMonth() + 1) & 0x0f) << 5) |
    (at.getUTCDate() & 0x1f);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.split('/').includes('..'))
      throw new Error(`Unsafe ZIP entry name: ${entry.name}`);
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + size;
    if (offset > MAX_TOTAL) throw new RangeError('ZIP too large');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
