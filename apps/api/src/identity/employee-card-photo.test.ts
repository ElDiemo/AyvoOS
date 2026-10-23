import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  CARD_PHOTO_MAX_BYTES,
  cardPhotoDimensions,
  normalizeCardPhoto,
} from './employee-card-photo.js';

describe('employee card photograph', () => {
  it('normalizes a PNG to a fresh square raster', async () => {
    const canvas = createCanvas(200, 100);
    canvas.getContext('2d').fillRect(0, 0, 200, 100);
    const input = canvas.toBuffer('image/png');
    expect(cardPhotoDimensions(input)).toEqual({ width: 200, height: 100 });
    const output = await normalizeCardPhoto(input);
    expect(output.equals(input)).toBe(false);
    const decoded = await loadImage(output);
    expect([decoded.width, decoded.height]).toEqual([512, 512]);
  });
  it('normalizes an actual JPEG rather than trusting an extension', async () => {
    const bytes = createCanvas(80, 120).toBuffer('image/jpeg');
    expect(cardPhotoDimensions(bytes)).toEqual({ width: 80, height: 120 });
    const output = await normalizeCardPhoto(bytes);
    expect(output.subarray(1, 4).toString()).toBe('PNG');
  });
  it.each([
    Buffer.from('<svg onload="alert(1)"></svg>'),
    Buffer.alloc(50),
    Buffer.alloc(CARD_PHOTO_MAX_BYTES + 1),
  ])('rejects invalid or oversized input', async (bytes) => {
    await expect(normalizeCardPhoto(bytes)).rejects.toMatchObject({ status: 422 });
  });
  it('rejects enormous claimed dimensions before native decode', () => {
    const bytes = createCanvas(2, 2).toBuffer('image/png');
    bytes.writeUInt32BE(100000, 16);
    expect(() => cardPhotoDimensions(bytes)).toThrow();
  });
});
