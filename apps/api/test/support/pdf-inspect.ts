import { createCanvas } from '@napi-rs/canvas';
import jsQRModule from 'jsqr';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Test helper: rasterises PDF pages with pdf.js and decodes their QR codes with jsQR, i.e. it
 * checks the generated document the way a phone camera would, not the way it was built.
 */

export const MM_PER_PT = 25.4 / 72;

// jsqr is CommonJS with a `default` export in its typings; unwrap it for NodeNext typing.
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ??
  jsQRModule) as unknown as (typeof jsQRModule)['default'];

export interface InspectedPdf {
  pageCount: number;
  /** Page sizes in millimetres. */
  pageSizesMm: { widthMm: number; heightMm: number }[];
  pdf: Awaited<ReturnType<typeof getDocument>['promise']>;
}

export async function openPdf(bytes: Uint8Array): Promise<InspectedPdf> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pageSizesMm: InspectedPdf['pageSizesMm'] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    pageSizesMm.push({ widthMm: (x1 - x0) * MM_PER_PT, heightMm: (y1 - y0) * MM_PER_PT });
  }
  return { pageCount: pdf.numPages, pageSizesMm, pdf };
}

export interface DecodedQr {
  data: string;
  /** QR symbol version (1–40). */
  version: number;
  /** Bounding box of the QR SYMBOL (finder pattern corners, without quiet zone), in mm from top-left. */
  symbolMm: { left: number; top: number; right: number; bottom: number };
}

/** All text on a page, joined with spaces. */
export async function pageText(inspected: InspectedPdf, pageNumber: number): Promise<string> {
  const page = await inspected.pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
}

/** Region of a page in millimetres from the top-left corner. */
export interface CropMm {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Renders one page at `pxPerMm` and decodes the QR code on it (null if none is readable). With
 * `crop`, only that region is decoded (for pages with several QR codes); coordinates in the
 * result stay relative to the whole page.
 */
export async function decodeQrOnPage(
  inspected: InspectedPdf,
  pageNumber: number,
  pxPerMm = 12,
  crop?: CropMm,
): Promise<DecodedQr | null> {
  const page = await inspected.pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: pxPerMm / (1 / MM_PER_PT) });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  await page.render({ canvas: canvas as never, viewport }).promise;

  const region = crop
    ? {
        x: Math.round(crop.left * pxPerMm),
        y: Math.round(crop.top * pxPerMm),
        w: Math.round(crop.width * pxPerMm),
        h: Math.round(crop.height * pxPerMm),
      }
    : { x: 0, y: 0, w: width, h: height };
  const pixels = canvas.getContext('2d').getImageData(region.x, region.y, region.w, region.h);
  const qr = jsQR(new Uint8ClampedArray(pixels.data), region.w, region.h);
  if (!qr) return null;

  // jsQR reports finder-pattern centres and outer corners of the symbol.
  const {
    topLeftCorner: tl,
    bottomRightCorner: br,
    topRightCorner: tr,
    bottomLeftCorner: bl,
  } = qr.location;
  const xs = [tl.x, tr.x, bl.x, br.x].map((x) => x + region.x);
  const ys = [tl.y, tr.y, bl.y, br.y].map((y) => y + region.y);
  return {
    data: qr.data,
    version: qr.version,
    symbolMm: {
      left: Math.min(...xs) / pxPerMm,
      top: Math.min(...ys) / pxPerMm,
      right: Math.max(...xs) / pxPerMm,
      bottom: Math.max(...ys) / pxPerMm,
    },
  };
}
