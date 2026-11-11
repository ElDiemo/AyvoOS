import { describe, expect, it } from 'vitest';
import { clearCookie, serializeCookie } from './cookies.js';

/**
 * Doc 064 (review 5847937038 (3)): the staff session cookie stays host-only — no Domain attribute,
 * so a sibling host such as portal.ayvo.co never receives it, and the internal app keeps its name
 * (`ayvo_session`) until a separate decision. Its other attributes are part of the same guarantee.
 */
describe('staff session cookie', () => {
  it('is host-only: no Domain attribute, whole path, HttpOnly, Secure, SameSite=Lax', () => {
    const cookie = serializeCookie('ayvo_session', 'token', 3600);
    const parts = cookie.split('; ');
    expect(parts[0]).toBe('ayvo_session=token');
    expect(parts.some((p) => /^domain=/i.test(p))).toBe(false);
    expect(parts).toEqual(
      expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=3600']),
    );
  });

  it('is cleared host-only as well', () => {
    expect(clearCookie('ayvo_session')).not.toMatch(/domain=/i);
    expect(clearCookie('ayvo_session')).toContain('Max-Age=0');
  });
});
