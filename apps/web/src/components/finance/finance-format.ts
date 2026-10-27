/** Display helpers of Finance (doc 039): Czech dates and amounts, never parsed back. */

/** "2026-10-01" → "1. 10. 2026" (a calendar date, no time zone). */
export function financeDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
}

/** "25000.00", "CZK" → "25 000,00 CZK" (the stored decimal string, only regrouped). */
export function financeAmount(amount: string | null, currency: string | null): string {
  if (amount === null || currency === null) return '—';
  const negative = amount.startsWith('-');
  const [whole, fraction = '00'] = amount.replace('-', '').split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${grouped},${fraction.padEnd(2, '0')} ${currency}`;
}

/** "2026-10" → "10/2026" (the handover month). */
export function financeMonth(month: string | null): string {
  if (!month) return '—';
  const [y, m] = month.split('-');
  return `${Number(m)}/${y}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** The exact sum of decimal amounts with at most 2 decimals ("1.5" + "2.25" → "3.75"); never a float. */
export function sumAmounts(amounts: readonly string[]): string {
  let cents = 0n;
  for (const a of amounts) {
    const negative = a.startsWith('-');
    const [whole, fraction = ''] = a.replace('-', '').split('.');
    const v = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    cents += negative ? -v : v;
  }
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Billed rooms × a price with at most 2 decimals, exactly ("350.5" × 12 → "4206.00"). */
export function timesRooms(rooms: number, price: string): string {
  const [whole, fraction = ''] = price.split('.');
  const cents =
    (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))) * BigInt(rooms);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
