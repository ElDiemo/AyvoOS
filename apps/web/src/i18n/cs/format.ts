/**
 * Czech formatting for the warehouse screens. Quantities are exact decimal strings from the API;
 * they are formatted as strings (digit grouping, decimal comma) and never converted to floating
 * point.
 */
const NBSP = ' ';

export function formatQuantityCs(value: string): string {
  const negative = value.startsWith('-');
  const [intPart = '0', fraction] = value.replace(/^[-+]/, '').split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${negative ? '−' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
}

const UNITS: Record<string, string> = { pcs: 'ks', sheet: 'arch', roll: 'role' };

/** Czech display name of a unit code from the API ("pcs" → "ks"); unknown codes stay as they are. */
export function unitCs(code: string): string {
  return UNITS[code] ?? code;
}

/** Signed quantity for ledgers: "+5", "−1". */
export function formatDeltaCs(value: string): string {
  return value.startsWith('-') ? formatQuantityCs(value) : `+${formatQuantityCs(value)}`;
}

const dateTime = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Prague',
});
const dateOnly = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/Prague',
});

export function formatDateTimeCs(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

/** For calendar dates "YYYY-MM-DD" (no time zone shift). */
export function formatDateCs(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate}T12:00:00Z`));
}
