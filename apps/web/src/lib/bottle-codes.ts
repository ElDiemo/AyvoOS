/**
 * Expected code range of the next bottle registration, shown before confirming. Only a preview:
 * the server allocates the codes, and a concurrent registration can shift them, so the result
 * screen always shows the codes actually created. Same format as the API (`common/codes.ts`):
 * serial zero-padded to 6 digits, wider beyond 999999.
 */
const BOTTLE_PREFIX = 'AYV-B-';

export function expectedBottleCodes(
  latestCode: string | null,
  quantity: number,
): { first: string; last: string } | null {
  let latest = 0;
  if (latestCode !== null) {
    const match = /^AYV-B-(\d+)$/.exec(latestCode);
    if (!match) return null;
    latest = Number(match[1]);
  }
  if (!Number.isSafeInteger(latest) || !Number.isInteger(quantity) || quantity < 1) return null;
  return { first: bottleCode(latest + 1), last: bottleCode(latest + quantity) };
}

function bottleCode(serial: number): string {
  return BOTTLE_PREFIX + (serial < 1_000_000 ? String(serial).padStart(6, '0') : String(serial));
}
