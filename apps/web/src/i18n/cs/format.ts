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

/** The zone timestamps are shown in when no site is known (AYVO's first site; doc 022). */
export const DEFAULT_TIME_ZONE = 'Europe/Prague';

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const dateOnly = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: DEFAULT_TIME_ZONE,
});

/**
 * A UTC timestamp from the API shown in the IANA time zone of the site it belongs to (doc 022:
 * stored in UTC, presented in the site's zone).
 */
export function formatDateTimeCs(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  if (!iso) return '—';
  let format = dateTimeFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
    dateTimeFormats.set(timeZone, format);
  }
  return format.format(new Date(iso));
}

/** For calendar dates "YYYY-MM-DD" (no time zone shift). */
export function formatDateCs(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate}T12:00:00Z`));
}
