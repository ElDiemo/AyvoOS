import { PDFDocument } from 'pdf-lib';

export class InvalidSignedPdf extends Error {}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
/** A complete PDF ends with %%EOF (also after incremental updates such as signatures). */
const EOF_TAIL = /%%EOF\s*$/;

/**
 * The signed original must be a real, complete PDF with at least one page before it is kept for
 * good (review SIGN122-R1): an immutable original that turns out to be a header or a truncated
 * upload would be an irreversible mistake. Checked by content only, with the runtime's existing
 * pdf-lib (as label artwork, ADR 0016) on a COPY that is parsed and never saved — the stored bytes
 * and any signatures in them stay exactly as uploaded. Bounded: the input is at most the upload
 * limit (SUPPLIER_DOCUMENT_MAX_BYTES), parsed once, nothing is rendered, fetched or executed.
 * Encrypted PDFs (permissions only) are read without decrypting; their page tree is plain.
 */
export async function inspectSignedPdf(bytes: Buffer): Promise<{ pages: number }> {
  if (bytes.length < 16 || !PDF_MAGIC.every((b, i) => bytes[i] === b))
    throw new InvalidSignedPdf('not a PDF');
  if (!EOF_TAIL.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1')))
    throw new InvalidSignedPdf('incomplete PDF (no end of file)');
  let pages: number;
  try {
    // pdf-lib reads the underlying ArrayBuffer and ignores a Buffer's byteOffset: an exact copy.
    const doc = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    pages = doc.getPageCount();
  } catch {
    throw new InvalidSignedPdf('the PDF cannot be opened');
  }
  if (pages < 1) throw new InvalidSignedPdf('the PDF has no page');
  return { pages };
}
