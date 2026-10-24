import { publicEmployeeCardSchema, type PublicEmployeeCard } from '@ayvo/types';

const escape = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');

/** RFC 2425: fold at 75 UTF-8 octets, never splitting a codepoint; continuation includes SP. */
export function foldVcardLine(line: string): string {
  const parts: string[] = [];
  let part = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > 75) {
      parts.push(part);
      part = ' ';
      size = 1;
    }
    part += char;
    size += bytes;
  }
  parts.push(part);
  return parts.join('\r\n');
}

/** Generated only from the anonymous, published projection. No invented first/last-name split. */
export function employeeCardVcard(input: PublicEmployeeCard): string {
  const card = publicEmployeeCardSchema.parse(input);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escape(card.name)}`, 'N:;;;;'];
  for (const [key, value] of [
    ['TITLE', card.role],
    ['ORG', card.company],
    ['NOTE', card.tagline],
    ['TEL;TYPE=WORK,VOICE', card.phone],
    ['EMAIL;TYPE=WORK', card.email],
    ['URL', card.website],
  ]) {
    if (value) lines.push(`${key}:${escape(value)}`);
  }
  if (card.linkedin) lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${escape(card.linkedin)}`);
  lines.push('END:VCARD');
  return lines.map(foldVcardLine).join('\r\n') + '\r\n';
}
