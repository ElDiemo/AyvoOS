/**
 * The CSV writer of the accountant export — Finance's own copy of the core's pure helper
 * (sales/sales-csv.ts), so the Finance unit imports no core module (ADR 0039).
 */

/**
 * One cell. A value starting with "=", "+", "-", "@", a tab or a carriage return gets a leading
 * apostrophe, so a spreadsheet shows it as text and never runs it as a formula (CSV injection).
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The file: UTF-8 with BOM (Excel shows the accents), ";" and CRLF (Czech Excel). */
export function csvFile(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
