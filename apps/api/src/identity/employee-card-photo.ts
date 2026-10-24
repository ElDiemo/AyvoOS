import { createCanvas, loadImage } from '@napi-rs/canvas';
import { domainError } from '../common/domain-error.js';

export const CARD_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const invalid = () =>
  domainError(
    422,
    'CARD_PHOTO_INVALID',
    'Nahrajte platnou fotografii JPEG nebo PNG do 5 MB a nejvýše 4096 × 4096 bodů.',
  );

/** Inspect raster dimensions BEFORE native decode, not just the untrusted upload MIME type. */
export function cardPhotoDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.length > CARD_PHOTO_MAX_BYTES) throw invalid();
  let width = 0,
    height = 0;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length && offset < 256 * 1024) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) throw invalid();
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
        if (size < 8) throw invalid();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += size;
    }
  }
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw invalid();
  return { width, height };
}

/** The only stored/public artifact is a fresh 512px PNG. No EXIF, filename, SVG or original bytes. */
export async function normalizeCardPhoto(bytes: Buffer): Promise<Buffer> {
  cardPhotoDimensions(bytes);
  try {
    const image = await loadImage(bytes);
    if (image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096)
      throw invalid();
    const canvas = createCanvas(512, 512);
    const context = canvas.getContext('2d');
    const size = Math.min(image.width, image.height);
    context.drawImage(
      image,
      (image.width - size) / 2,
      (image.height - size) / 2,
      size,
      size,
      0,
      0,
      512,
      512,
    );
    return canvas.toBuffer('image/png');
  } catch {
    throw invalid();
  }
}
