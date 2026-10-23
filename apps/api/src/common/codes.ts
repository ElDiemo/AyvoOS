/**
 * Human-readable codes: PREFIX + serial zero-padded to 6 digits, wider once the serial exceeds
 * 999999 (AYV-B-000001 … AYV-B-999999, AYV-B-1000000 …). Mirrors the SQL function
 * `ayvo_format_code`, which CHECK constraints use to keep code and serial consistent.
 */
export const CODE_PREFIX = {
  bottle: 'AYV-B-',
  bottleCreationBatch: 'BC-',
  labelPrintJob: 'PJ-',
  goodsReceipt: 'GR-',
  crate: 'AYV-C-',
  crateRegistration: 'CR-',
  hotel: 'HT-',
  order: 'ORD-',
  shipment: 'SHP-',
  printJob: 'PRJ-',
  salesProspect: 'AKV-',
} as const;

export function formatCode(prefix: string, serial: bigint): string {
  if (serial < 1n) throw new RangeError('Serial must be positive');
  return prefix + (serial < 1_000_000n ? serial.toString().padStart(6, '0') : serial.toString());
}

/**
 * Parses an operator's search input into a serial: "AYV-B-000123", "ayv-b-123", "000123" and
 * "123" all mean serial 123. Returns null if the input is not a valid code or number.
 */
export function parseCodeSerial(prefix: string, input: string): bigint | null {
  let digits = input.trim().toUpperCase();
  if (digits.startsWith(prefix)) digits = digits.slice(prefix.length);
  if (!/^\d{1,18}$/.test(digits)) return null;
  const serial = BigInt(digits);
  return serial >= 1n ? serial : null;
}
