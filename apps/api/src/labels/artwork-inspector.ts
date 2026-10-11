import type { LabelArtworkFormat } from '@ayvo/types';
import { PDFDocument } from 'pdf-lib';

/**
 * Validates uploaded label artwork by its CONTENT (magic bytes and structure), never by filename
 * or client-supplied content type, and extracts what the label designer and the PDF renderer
 * need. Supported: SVG (vector, preferred for print), PNG and JPEG.
 */

export class InvalidArtworkError extends Error {}

export interface InspectedArtwork {
  format: LabelArtworkFormat;
  contentType: string;
  extension: string;
  /** Intrinsic proportions: pixels for PNG/JPEG, user units (viewBox) for SVG. */
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** Physical size stated by the file itself (SVG width/height in mm, cm or in), else null. */
  suggestedSizeMm: { widthMm: number; heightMm: number } | null;
}

/** Decompression-bomb guard for raster artwork. 12000 px ≈ 1 m at 300 dpi. */
export const RASTER_MAX_SIDE_PX = 12_000;
export const RASTER_MAX_PIXELS = 100_000_000;

export async function inspectArtwork(bytes: Buffer): Promise<InspectedArtwork> {
  if (bytes.length === 0) throw new InvalidArtworkError('The file is empty');
  if (isPng(bytes)) return inspectPng(bytes);
  if (isJpeg(bytes)) return inspectJpeg(bytes);
  if (looksLikeSvg(bytes)) return inspectSvg(bytes);
  throw new InvalidArtworkError('Unsupported file type: upload SVG, PNG or JPEG artwork');
}

/**
 * pdf-lib reads the underlying ArrayBuffer and ignores a Buffer's byteOffset; uploads (multer)
 * and pooled reads are slices of larger buffers. Always hand it an exact copy.
 */
export function exactCopy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

// --- PNG -----------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

async function inspectPng(bytes: Buffer): Promise<InspectedArtwork> {
  if (bytes.length < 33 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    throw new InvalidArtworkError('Invalid PNG file');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  checkRasterSize(width, height);
  // Decode once with the same library the renderer uses, so a broken file fails at upload time.
  await PDFDocument.create()
    .then((doc) => doc.embedPng(exactCopy(bytes)))
    .catch(() => {
      throw new InvalidArtworkError('The PNG file could not be decoded');
    });
  return raster('PNG', 'image/png', 'png', width, height);
}

// --- JPEG ----------------------------------------------------------------------------------------

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Start-of-frame markers carrying the image size (SOF0–SOF15 except DHT, JPG, DAC). */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

async function inspectJpeg(bytes: Buffer): Promise<InspectedArtwork> {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new InvalidArtworkError('Invalid JPEG file');
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (SOF_MARKERS.has(marker)) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      checkRasterSize(width, height);
      await PDFDocument.create()
        .then((doc) => doc.embedJpg(exactCopy(bytes)))
        .catch(() => {
          throw new InvalidArtworkError('The JPEG file could not be decoded');
        });
      return raster('JPEG', 'image/jpeg', 'jpg', width, height);
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  throw new InvalidArtworkError('Invalid JPEG file (no image size found)');
}

function checkRasterSize(width: number, height: number): void {
  if (width < 1 || height < 1) throw new InvalidArtworkError('The image has no pixels');
  if (
    width > RASTER_MAX_SIDE_PX ||
    height > RASTER_MAX_SIDE_PX ||
    width * height > RASTER_MAX_PIXELS
  ) {
    throw new InvalidArtworkError(
      `The image is too large (max ${RASTER_MAX_SIDE_PX} px per side, ${RASTER_MAX_PIXELS / 1e6} megapixels)`,
    );
  }
}

function raster(
  format: LabelArtworkFormat,
  contentType: string,
  extension: string,
  width: number,
  height: number,
): InspectedArtwork {
  return {
    format,
    contentType,
    extension,
    intrinsicWidth: width,
    intrinsicHeight: height,
    suggestedSizeMm: null,
  };
}

// --- SVG -----------------------------------------------------------------------------------------

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head);
}

/**
 * Deny-list for active or external content. SVG artwork is shown to administrators in the
 * browser (as an <img>, served with a sandboxing CSP) and converted to PDF on the server, so it
 * must be self-contained static vector art.
 */
const SVG_FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /<!DOCTYPE|<!ENTITY/i, reason: 'DOCTYPE/ENTITY declarations are not allowed' },
  { pattern: /<script[\s>/]/i, reason: 'scripts are not allowed' },
  { pattern: /<foreignObject[\s>/]/i, reason: 'foreignObject is not allowed' },
  {
    pattern: /<(iframe|embed|object|audio|video|use\s[^>]*href\s*=\s*["'](?!#))/i,
    reason: 'embedded or external content is not allowed',
  },
  { pattern: /\son[a-z]+\s*=/i, reason: 'event handler attributes are not allowed' },
  { pattern: /javascript:/i, reason: 'javascript: URLs are not allowed' },
  { pattern: /@import/i, reason: 'CSS @import is not allowed' },
];

/** Every href must be an in-document reference (#id) or an inline PNG/JPEG data URI. */
const HREF_ATTRIBUTE = /(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi;
const SAFE_HREF = /^(#[\w.-]+|data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+)$/;
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi;

async function inspectSvg(bytes: Buffer): Promise<InspectedArtwork> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new InvalidArtworkError('The SVG file is not valid UTF-8');
  }
  if (text.includes('\u0000')) throw new InvalidArtworkError('Invalid SVG file');

  for (const { pattern, reason } of SVG_FORBIDDEN) {
    if (pattern.test(text)) throw new InvalidArtworkError(`Unsafe SVG: ${reason}`);
  }
  for (const [, , href] of text.matchAll(HREF_ATTRIBUTE)) {
    if (!SAFE_HREF.test(href!.trim())) {
      throw new InvalidArtworkError('Unsafe SVG: external references are not allowed');
    }
  }
  for (const [, , url] of text.matchAll(CSS_URL)) {
    if (!url!.trim().startsWith('#')) {
      throw new InvalidArtworkError('Unsafe SVG: external references are not allowed');
    }
  }

  const root = /<svg\b([^>]*)>/i.exec(text)?.[1];
  if (root === undefined) throw new InvalidArtworkError('Invalid SVG file (no <svg> element)');
  const width = parseLength(attribute(root, 'width'));
  const height = parseLength(attribute(root, 'height'));
  const viewBox = parseViewBox(attribute(root, 'viewBox'));

  const intrinsicWidth = viewBox?.width ?? width?.value;
  const intrinsicHeight = viewBox?.height ?? height?.value;
  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) {
    throw new InvalidArtworkError(
      'The SVG needs a viewBox or width and height to define its proportions',
    );
  }

  const suggestedSizeMm =
    width?.mm !== undefined && height?.mm !== undefined
      ? { widthMm: round2(width.mm), heightMm: round2(height.mm) }
      : null;

  return {
    format: 'SVG',
    contentType: 'image/svg+xml',
    extension: 'svg',
    intrinsicWidth,
    intrinsicHeight,
    suggestedSizeMm,
  };
}

function attribute(tagAttributes: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tagAttributes);
  return match?.[2]?.trim();
}

const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, in: 25.4 };

function parseLength(value: string | undefined): { value: number; mm?: number } | undefined {
  const match = value && /^(\d+(?:\.\d+)?)\s*(mm|cm|in|px|pt)?$/i.exec(value);
  if (!match) return undefined;
  const number = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const factor = unit ? MM_PER_UNIT[unit] : undefined;
  return { value: number, mm: factor === undefined ? undefined : number * factor };
}

function parseViewBox(value: string | undefined): { width: number; height: number } | undefined {
  const parts = value?.split(/[\s,]+/).map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return { width: parts[2]!, height: parts[3]! };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
