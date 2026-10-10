/**
 * Display formatting. Timestamps are stored in UTC; the admin UI shows them in AYVO's local time
 * (Europe/Prague) — an assumption to confirm (doc 016, open decisions).
 */
export const DISPLAY_TIME_ZONE = 'Europe/Prague';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DISPLAY_TIME_ZONE,
});

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

export function formatMm(value: number): string {
  return `${Number(value.toFixed(2))} mm`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function codeRange(first: string, last: string): string {
  return first === last ? first : `${first} – ${last}`;
}
