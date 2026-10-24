import { describe, expect, it } from 'vitest';
import {
  employeeCardFieldsSchema,
  employeeCardSlugSchema,
  publicEmployeeCardSchema,
} from './employee-cards.js';

const fields = {
  name: 'Jana Testová',
  role: 'Obchod',
  company: '',
  tagline: '',
  phone: '',
  email: '',
  website: '',
  linkedin: '',
  photoId: null,
};
describe('employee card boundary', () => {
  it('does not require or derive a public email/phone', () =>
    expect(employeeCardFieldsSchema.parse(fields)).toEqual(fields));
  it.each(['a\r\nEMAIL:private@example.com', 'a\u0000b', 'a\tb'])(
    'rejects controls/injection: %j',
    (value) => {
      expect(employeeCardFieldsSchema.safeParse({ ...fields, name: value }).success).toBe(false);
    },
  );
  it.each([
    'javascript:alert(1)',
    'http://example.com',
    'https://user:pass@example.com',
    '//example.com',
  ])('refuses unsafe URL %s', (website) => {
    expect(employeeCardFieldsSchema.safeParse({ ...fields, website }).success).toBe(false);
  });
  it.each(['no url', 'https://linkedin.com.attacker.example/test'])(
    'refuses invalid LinkedIn without throwing %s',
    (linkedin) => {
      expect(employeeCardFieldsSchema.safeParse({ ...fields, linkedin }).success).toBe(false);
    },
  );
  it('refuses internal fields in public data', () => {
    const { photoId, ...publicFields } = fields;
    expect(photoId).toBeNull();
    expect(
      publicEmployeeCardSchema.safeParse({
        ...publicFields,
        slug: 'jana-testova',
        version: 1,
        hasPhoto: false,
        userId: 'private',
        roles: ['ADMIN'],
      }).success,
    ).toBe(false);
  });
  it.each(['../admin', 'Tomáš-Hanzl', 'a/b', 'a%2fb', 'test\r\nX:header', '-test', 'test-'])(
    'rejects an unsafe address %s',
    (slug) => {
      expect(employeeCardSlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});
