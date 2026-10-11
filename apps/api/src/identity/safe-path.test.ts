import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-path.js';

describe('safeNextPath (no open redirects after sign-in)', () => {
  it('keeps same-site paths', () => {
    expect(safeNextPath('/warehouse/stock?x=1')).toBe('/warehouse/stock?x=1');
    expect(safeNextPath('/')).toBe('/');
  });

  it.each([
    'https://evil.example',
    '//evil.example/x',
    '/\\evil.example',
    'javascript:alert(1)',
    '/api/auth/logout',
    '/x\u0000y',
    '/x\ny',
    '',
    42,
    undefined,
    `/${'a'.repeat(600)}`,
  ])('replaces %j by "/"', (value) => {
    expect(safeNextPath(value)).toBe('/');
  });
});
