import { describe, expect, it } from 'vitest';
import { emailKey, nameKey, phoneKey, websiteKey } from './sales-keys.js';

describe('possible-duplicate keys (doc 034 §8)', () => {
  it('compares names without accents, punctuation and generic words', () => {
    expect(nameKey('Hotel Lípa')).toBe('lipa');
    expect(nameKey('LIPA – hotel garni')).toBe('lipa');
    expect(nameKey('Penzion U Lípy')).toBe('u lipy');
    // Only generic words: the plain name stays, never an empty key.
    expect(nameKey('Hotel')).toBe('hotel');
  });
  it('compares websites by host', () => {
    expect(websiteKey('https://www.Lipa.cz/cs/kontakt')).toBe('lipa.cz');
    expect(websiteKey('lipa.cz')).toBe('lipa.cz');
    expect(websiteKey(null)).toBeNull();
  });
  it('compares phones by their last nine digits, foreign numbers included', () => {
    expect(phoneKey('+420 721 000 111')).toBe('721000111');
    expect(phoneKey('00420721000111')).toBe('721000111');
    expect(phoneKey('+43 (0)662 123 456')).toBe('662123456');
    expect(phoneKey('112')).toBeNull();
    expect(emailKey(' Recepce@Lipa.CZ ')).toBe('recepce@lipa.cz');
  });
});
