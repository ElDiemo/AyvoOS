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

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
