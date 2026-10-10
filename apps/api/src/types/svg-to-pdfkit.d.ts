declare module 'svg-to-pdfkit' {
  interface SvgToPdfOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    assumePt?: boolean;
    warningCallback?: (message: string) => void;
  }
  export default function SVGtoPDF(
    doc: PDFKit.PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: SvgToPdfOptions,
  ): void;
}
