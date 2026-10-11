import { createCanvas } from '@napi-rs/canvas';

/** Test artwork: a 70 × 110 mm label with a dark border and a light body (vector). */
export const SVG_70x110 = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="70mm" height="110mm" viewBox="0 0 700 1100">
  <rect x="0" y="0" width="700" height="1100" fill="#1c1917"/>
  <rect x="40" y="40" width="620" height="1020" fill="#f5f5f4"/>
  <circle cx="350" cy="300" r="180" fill="#a8a29e"/>
</svg>`,
);

/** Real PNG/JPEG raster artwork of the given pixel size (dark frame, light body). */
export function rasterArtwork(format: 'png' | 'jpeg', width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1c1917';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e7e5e4';
  ctx.fillRect(width * 0.05, height * 0.05, width * 0.9, height * 0.9);
  return format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', 90);
}
