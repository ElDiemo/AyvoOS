import { describe, expect, it } from 'vitest';
import { employeeCardVcard, foldVcardLine } from './employee-card-vcard.js';

const card = {
  slug: 'jana-testova',
  version: 2,
  hasPhoto: false,
  name: 'Jana Testová',
  role: 'Obchod',
  company: 'AYVO, tým; CZ',
  tagline: 'Refill \\ Redefine',
  phone: '+420 111 222 333',
  email: 'jana@example.com',
  website: 'https://example.com',
  linkedin: '',
};
describe('published vCard', () => {
  it('preserves Czech UTF-8 and uses CRLF; does not guess given/family names', () => {
    const text = employeeCardVcard(card);
    expect(text).toContain('FN:Jana Testová\r\nN:;;;;\r\n');
    expect(text).toContain('ORG:AYVO\\, tým\\; CZ\r\n');
    expect(text).toContain('NOTE:Refill \\\\ Redefine\r\n');
    expect(text).toContain('TEL;TYPE=WORK,VOICE:+420 111 222 333\r\n');
    expect(text).toMatch(/END:VCARD\r\n$/);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(text).not.toMatch(/userId|photoId|version|slug|ADMIN/);
  });
  it('folds by octets and never breaks a multibyte codepoint', () => {
    const original = 'NOTE:' + 'Žluťoučký kůň '.repeat(25);
    const folded = foldVcardLine(original);
    for (const line of folded.split('\r\n'))
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(folded.replaceAll('\r\n ', '')).toBe(original);
  });
  it('rejects a vCard line injection even if called without the HTTP input boundary', () => {
    expect(() =>
      employeeCardVcard({ ...card, name: 'Jana\r\nEMAIL:attacker@example.com' }),
    ).toThrow();
  });
});
