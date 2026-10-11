import { qrGeometry, QR_QUIET_ZONE_MODULES, type QrErrorCorrection } from '@ayvo/types';
import QRCode from 'qrcode';

/**
 * Renders a QR code as SVG exactly like the print PDF: a white square for the whole element box
 * (quiet zone included) with the symbol placed by the shared `qrGeometry` contract. The SVG uses
 * module units (viewBox = total modules), so it scales to whatever box the caller sizes it to.
 * Works in server and client components.
 */
export function QrCode({
  value,
  level,
  className,
  title,
}: {
  value: string;
  /** Error correction — always the configured level, so preview density matches the print. */
  level: QrErrorCorrection;
  className?: string;
  title?: string;
}) {
  const qr = QRCode.create(value, { errorCorrectionLevel: level });
  const size = qr.modules.size;
  // Geometry in module units: a box `totalModules` wide.
  const { totalModules, symbol } = qrGeometry(
    { xMm: 0, yMm: 0, widthMm: size + 2 * QR_QUIET_ZONE_MODULES },
    size,
  );
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) path += `M${col + symbol.xMm} ${row + symbol.yMm}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`0 0 ${totalModules} ${totalModules}`}
      className={className}
      role="img"
      aria-label={title ?? 'QR code'}
      shapeRendering="crispEdges"
      data-qr-value={value}
      data-qr-level={level}
    >
      <rect width={totalModules} height={totalModules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
