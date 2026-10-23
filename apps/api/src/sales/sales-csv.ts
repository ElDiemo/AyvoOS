import type { ImportField } from '@ayvo/types';

/**
 * CSV of Obchod (doc 034 §13): reading the tables salespeople keep today (comma or semicolon,
 * quotes, empty cells, multi-line notes, UTF-8 or the Windows-1250 of Czech Excel) and writing
 * an export that a spreadsheet opens without running anything. Values are text: a phone keeps
 * its "+" and leading zeros, nothing is converted to a number.
 */

export class CsvError extends Error {
  constructor(
    readonly code: 'CSV_EMPTY' | 'CSV_UNTERMINATED_QUOTE' | 'CSV_QUOTE_INVALID' | 'CSV_NO_DATA',
    /** The physical line where the problem starts (1-based). */
    readonly line: number | null = null,
  ) {
    super(code);
  }
}

export interface ParsedCsv {
  encoding: 'UTF-8' | 'windows-1250';
  delimiter: ',' | ';';
  headers: string[];
  /**
   * Data records with their spreadsheet row number (the header is row 1). `badQuotes`: cells with
   * text after their closing quote — kept in the cell, never dropped, and the row is refused.
   */
  rows: { row: number; cells: string[]; badQuotes: number[] }[];
}

/** UTF-8 (with or without BOM); a file that is not valid UTF-8 is read as Windows-1250. */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: ParsedCsv['encoding'] } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return { text, encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1250').decode(bytes), encoding: 'windows-1250' };
  }
}

/** The delimiter of the header line: the more frequent of ";" and "," outside quotes. */
function detectDelimiter(text: string): ',' | ';' {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch === ',') commas++;
    else if (!quoted && ch === ';') semicolons++;
  }
  return semicolons >= commas && semicolons > 0 ? ';' : ',';
}

interface CsvRecord {
  line: number;
  cells: string[];
  badQuotes: number[];
}

/**
 * RFC 4180 records: quoted cells may hold the delimiter, doubled quotes and line breaks. Spaces
 * after a closing quote are ignored; any other text there is kept (appended to the cell) and the
 * cell is reported, so nothing is ever cut off silently.
 */
function records(text: string, delimiter: string): CsvRecord[] {
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let badQuotes: number[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  /** Spaces after a closing quote: dropped at the end of the cell, kept before stray text. */
  let tail = '';
  let line = 1;
  let start = 1;
  let quoteLine = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '' && !afterQuote) {
      quoted = true;
      quoteLine = line;
      cell = '';
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
      afterQuote = false;
      tail = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      out.push({ line: start, cells, badQuotes });
      cells = [];
      badQuotes = [];
      cell = '';
      afterQuote = false;
      tail = '';
      line++;
      start = line;
    } else if (!afterQuote) {
      cell += ch;
    } else if (ch === ' ' || ch === '\t') {
      tail += ch;
    } else {
      if (badQuotes.at(-1) !== cells.length) badQuotes.push(cells.length);
      cell += tail + ch;
      tail = '';
    }
  }
  if (quoted) throw new CsvError('CSV_UNTERMINATED_QUOTE', quoteLine);
  if (cell !== '' || cells.length) {
    cells.push(cell);
    out.push({ line: start, cells, badQuotes });
  }
  return out;
}

export function parseCsv(bytes: Uint8Array): ParsedCsv {
  const { text: raw, encoding } = decodeCsv(bytes);
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new CsvError('CSV_EMPTY');
  const delimiter = detectDelimiter(text);
  const all = records(text, delimiter);
  const blank = (cells: string[]) => cells.every((c) => c.trim() === '');
  const headerIndex = all.findIndex((r) => !blank(r.cells));
  if (headerIndex < 0) throw new CsvError('CSV_EMPTY');
  const header = all[headerIndex]!;
  if (header.badQuotes.length) throw new CsvError('CSV_QUOTE_INVALID', header.line);
  const headers = header.cells.map((h) => h.trim());
  const rows: ParsedCsv['rows'] = [];
  // Spreadsheet rows: every record counts (an empty row too), so the numbers match Excel.
  all.slice(headerIndex + 1).forEach((r, i) => {
    if (!blank(r.cells)) {
      rows.push({ row: headerIndex + 2 + i, cells: r.cells, badQuotes: r.badQuotes });
    }
  });
  if (!rows.length) throw new CsvError('CSV_NO_DATA');
  return { encoding, delimiter, headers, rows };
}

/** Lower case without accents and punctuation: "Kontaktní osoba" → "kontaktni osoba". */
export function headerKey(h: string): string {
  return h
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SUGGEST: [RegExp, ImportField][] = [
  [/^(nazev|nazev hotelu|hotel|nazev ubytovani|ubytovani|jmeno hotelu|name|hotel name)$/, 'name'],
  [/^(zeme|stat|country|kod zeme)$/, 'countryCode'],
  [/^(mesto|obec|city|lokalita)$/, 'city'],
  [/^(adresa|ulice|ulice a cislo|address|street)$/, 'addressLine1'],
  [/^(psc|zip|postal code|postcode)$/, 'postalCode'],
  [/^(pokoje|pocet pokoju|pokoju|rooms|odhad pokoju)$/, 'roomsEstimate'],
  [/^(typ|typ ubytovani|type)$/, 'accommodationType'],
  [/^(web|www|website|webove stranky|url)$/, 'website'],
  [/^(zdroj|source|zdroj kontaktu)$/, 'source'],
  [/^(priorita|priority)$/, 'priority'],
  [/^(poznamka|poznamky|note|notes)$/, 'note'],
  [/^(kontakt|kontaktni osoba|jmeno|osoba|contact|contact person)$/, 'contactLabel'],
  [/^(pozice|funkce|position|role)$/, 'contactPosition'],
  [/^(e ?mail|email kontaktu|mail)$/, 'contactEmail'],
  [/^(telefon|tel|mobil|phone|telefonni cislo)$/, 'contactPhone'],
  // Columns of the old tables whose meaning is not confirmed: kept as original values only.
  [/^(stav|vysledek|datum.*|follow ?up.*|faze|posledni kontakt|osloveno.*)$/, 'original'],
];

/** A proposal from the header names; unknown columns are ignored unless the user decides. */
export function suggestMapping(headers: string[]): ImportField[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const key = headerKey(h);
    const hit = SUGGEST.find(([re]) => re.test(key))?.[1] ?? 'ignore';
    if (hit !== 'original' && hit !== 'ignore') {
      if (used.has(hit)) return 'ignore';
      used.add(hit);
    }
    return hit;
  });
}

/** A leading apostrophe our export adds before "=", "+", "-" or "@" is not part of the value. */
export const unescapeCell = (v: string) => v.replace(/^'(?=[=+\-@\t\r])/, '');

/**
 * One export cell. A value starting with "=", "+", "-", "@", a tab or a carriage return gets a
 * leading apostrophe, so a spreadsheet shows it as text and never runs it as a formula (CSV
 * injection). Only the exported text changes — never the data in the database.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The export file: UTF-8 with BOM (Excel shows the accents), ";" and CRLF (Czech Excel). */
export function csvFile(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
