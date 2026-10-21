import { BARCODE_PATTERN } from '@ayvo/types';
import { warehouseCs } from '@/i18n/cs/warehouse';

/**
 * A keyboard-wedge scanner on a Czech keyboard layout types "ěščřžýáíé" instead of the digits:
 * such a value is explained, never converted (doc 033).
 */
const CZECH_LAYOUT = /[ěščřžýáíéůú]/i;

/** null when the scanned text can be a goods barcode, else the Czech explanation. */
export function barcodeProblem(code: string): string | null {
  if (BARCODE_PATTERN.test(code)) return null;
  return CZECH_LAYOUT.test(code) ? warehouseCs.barcodes.czechLayout : warehouseCs.barcodes.invalid;
}

/** A link (e.g. the QR of a bottle or crate) is never a goods barcode. */
export const looksLikeLink = (code: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(code);
