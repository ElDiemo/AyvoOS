import type {
  AccommodationType,
  ImportField,
  ImportOptions,
  ImportRowError,
  Priority,
} from '@ayvo/types';
import { z } from 'zod';
import { headerKey, unescapeCell, type ParsedCsv } from './sales-csv.js';
import { emailKey, nameKey, phoneKey, websiteKey } from './sales-keys.js';

/**
 * One CSV row as a prospect draft (doc 034 §13): only what the row says, in the user's mapping,
 * with explicit defaults. Nothing is derived: no country from a domain or phone, no activity or
 * task from an old status column — those are kept in the note as labelled original values.
 */
export interface ImportDraft {
  row: number;
  name: string | null;
  countryCode: string | null;
  city: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  roomsEstimate: number | null;
  accommodationType: AccommodationType | null;
  website: string | null;
  source: string | null;
  priority: Priority | null;
  note: string | null;
  contact: {
    label: string | null;
    position: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  errors: ImportRowError[];
  keys: { name: string | null; website: string | null; email: string | null; phone: string | null };
}

/** Country names salespeople write instead of the code; anything else must be an ISO code. */
const COUNTRY_NAMES: Record<string, string> = {
  cesko: 'CZ',
  'ceska republika': 'CZ',
  cr: 'CZ',
  czechia: 'CZ',
  'czech republic': 'CZ',
  slovensko: 'SK',
  'slovenska republika': 'SK',
  sr: 'SK',
  slovakia: 'SK',
  rakousko: 'AT',
  austria: 'AT',
  nemecko: 'DE',
  germany: 'DE',
  polsko: 'PL',
  poland: 'PL',
  madarsko: 'HU',
  hungary: 'HU',
};

const TYPES: Record<string, AccommodationType> = {
  hotel: 'HOTEL',
  penzion: 'PENSION',
  pension: 'PENSION',
  apartmany: 'APARTMENTS',
  apartman: 'APARTMENTS',
  apartmans: 'APARTMENTS',
  apartments: 'APARTMENTS',
  hostel: 'HOSTEL',
  jine: 'OTHER',
  other: 'OTHER',
};

const PHONE = /^\+?[0-9 ()./-]{3,40}$/;
const LIMITS: Partial<Record<ImportField, number>> = {
  city: 120,
  addressLine1: 200,
  postalCode: 20,
  website: 300,
  source: 200,
  contactPosition: 120,
  contactLabel: 160,
  contactEmail: 254,
  contactPhone: 40,
};
const short = (v: string) => (v.length > 80 ? `${v.slice(0, 77)}…` : v);

export const ORIGINAL_HEADING = 'Původní údaje z importu (význam nepotvrzen):';

export function buildDrafts(csv: ParsedCsv, options: ImportOptions): ImportDraft[] {
  const { mapping, defaults, overrides } = options;
  return csv.rows.map(({ row, cells, badQuotes }) => {
    const errors: ImportRowError[] = [];
    const fail = (code: ImportRowError['code'], field: string | null, value: string | null) =>
      errors.push({ code, field, value: value === null ? null : short(value) });
    const value = (field: ImportField): string | null => {
      const i = mapping.indexOf(field);
      if (i < 0) return null;
      const v = unescapeCell((cells[i] ?? '').trim());
      return v === '' ? null : v;
    };
    const text = (field: ImportField): string | null => {
      const v = value(field);
      const max = LIMITS[field];
      if (v !== null && max !== undefined && v.length > max) {
        fail('TEXT_TOO_LONG', field, v);
        return null;
      }
      return v;
    };
    const fix = overrides[String(row)] ?? {};

    // Text after a closing quote: the cell cannot be read reliably, so the row is never imported.
    for (const i of badQuotes) {
      fail('QUOTE_INVALID', csv.headers[i] || `Sloupec ${i + 1}`, cells[i]!.trim());
    }
    for (let i = mapping.length; i < cells.length; i++) {
      if (cells[i]!.trim()) {
        fail('EXTRA_CELLS', null, cells[i]!.trim());
        break;
      }
    }

    const name = fix.name ?? value('name');
    if (!name) fail('NAME_MISSING', 'name', null);
    else if (name.length > 200) fail('NAME_TOO_LONG', 'name', name);

    let countryCode: string | null = fix.countryCode ?? null;
    if (!countryCode) {
      const raw = value('countryCode');
      if (raw) {
        const upper = raw.toUpperCase();
        countryCode = /^[A-Z]{2}$/.test(upper) ? upper : (COUNTRY_NAMES[headerKey(raw)] ?? null);
        if (!countryCode) fail('COUNTRY_INVALID', 'countryCode', raw);
      } else if (defaults.countryCode) {
        countryCode = defaults.countryCode;
      } else {
        fail('COUNTRY_MISSING', 'countryCode', null);
      }
    }

    let roomsEstimate: number | null = null;
    const rooms = value('roomsEstimate');
    if (rooms) {
      const n = /^\d[\d\s]*$/.test(rooms) ? Number(rooms.replace(/\s/g, '')) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= 100000) roomsEstimate = n;
      else fail('ROOMS_INVALID', 'roomsEstimate', rooms);
    }

    let accommodationType: AccommodationType | null = null;
    const type = value('accommodationType');
    if (type) {
      accommodationType = TYPES[headerKey(type)] ?? null;
      if (!accommodationType) fail('TYPE_INVALID', 'accommodationType', type);
    }

    let priority: Priority | null = null;
    const prio = value('priority');
    if (prio) {
      const p = prio.toUpperCase();
      if (p === 'A' || p === 'B' || p === 'C') priority = p;
      else fail('PRIORITY_INVALID', 'priority', prio);
    }

    const originals = mapping
      .map((f, i) => (f === 'original' ? [csv.headers[i] || `Sloupec ${i + 1}`, cells[i]] : null))
      .filter((x): x is [string, string] => !!x && !!x[1]?.trim())
      .map(([h, v]) => `${h}: ${unescapeCell(v.trim())}`);
    const noteParts = [
      value('note'),
      originals.length ? [ORIGINAL_HEADING, ...originals].join('\n') : null,
    ];
    const note = noteParts.filter(Boolean).join('\n\n') || null;
    if (note && note.length > 4000) fail('NOTE_TOO_LONG', 'note', null);

    const email = text('contactEmail');
    if (email && !z.email().safeParse(email).success) fail('EMAIL_INVALID', 'contactEmail', email);
    const phone = text('contactPhone');
    if (phone && !PHONE.test(phone)) fail('PHONE_INVALID', 'contactPhone', phone);
    const position = text('contactPosition');
    const ownLabel = text('contactLabel');
    let contact: ImportDraft['contact'] = null;
    if (ownLabel || position || email || phone) {
      const label = ownLabel ?? defaults.contactLabel;
      if (!label) fail('CONTACT_LABEL_MISSING', 'contactLabel', null);
      contact = { label, position, email, phone };
    }

    const website = text('website');
    const draft: ImportDraft = {
      row,
      name,
      countryCode,
      city: text('city'),
      addressLine1: text('addressLine1'),
      postalCode: text('postalCode'),
      roomsEstimate,
      accommodationType,
      website,
      source: text('source'),
      priority,
      note,
      contact,
      errors,
      keys: {
        name: name && countryCode ? `${countryCode}:${nameKey(name)}` : null,
        website: websiteKey(website),
        email: emailKey(email),
        phone: phoneKey(phone),
      },
    };
    return draft;
  });
}

/** Rows of the same file that look like the same hotel (same name + country, web, e-mail, phone). */
export function fileDuplicates(drafts: ImportDraft[]): Map<number, number[]> {
  const byKey = new Map<string, number[]>();
  for (const d of drafts) {
    for (const [kind, key] of Object.entries(d.keys)) {
      if (!key) continue;
      const k = `${kind}:${key}`;
      byKey.set(k, [...(byKey.get(k) ?? []), d.row]);
    }
  }
  const out = new Map<number, number[]>();
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    for (const r of rows) {
      const others = new Set(out.get(r) ?? []);
      for (const o of rows) if (o !== r) others.add(o);
      out.set(
        r,
        [...others].sort((a, b) => a - b),
      );
    }
  }
  return out;
}
