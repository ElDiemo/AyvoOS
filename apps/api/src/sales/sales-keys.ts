/**
 * Keys of the possible-duplicate warning (doc 034 §8). They only find candidates for a person to
 * look at — nothing is unique and nothing is ever merged automatically.
 */

/** Words that say what kind of place it is, not which one ("Hotel Lípa" ≈ "Lípa"). */
const GENERIC_WORDS = new Set([
  'hotel',
  'hotels',
  'penzion',
  'pension',
  'pensione',
  'apartmany',
  'apartments',
  'apartment',
  'apartmans',
  'hostel',
  'resort',
  'spa',
  'wellness',
  'garni',
  'boutique',
  'the',
  'a',
  'and',
  'und',
]);

const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** The name without accents, punctuation and generic words; the plain name if nothing remains. */
export function nameKey(name: string): string {
  const words = plain(name).split(' ').filter(Boolean);
  const specific = words.filter((w) => !GENERIC_WORDS.has(w));
  return (specific.length ? specific : words).join(' ');
}

/** The host of a website without scheme, "www." and path ("https://www.Lipa.cz/cs" → "lipa.cz"). */
export function websiteKey(website: string | null): string | null {
  if (!website) return null;
  const host = website
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/^www\./, '')
    .replace(/:\d+$/, '');
  return host || null;
}

export function emailKey(email: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/**
 * The last nine digits of a phone number: "+420 721 000 111", "00420721000111" and "721 000 111"
 * are the same line. Fewer than six digits are too short to compare.
 */
export function phoneKey(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(-9);
}
