import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-path';

describe('safe next path (open redirect protection)', () => {
  it.each([
    ['/\\evil.com', '/'],
    ['//evil.com', '/'],
    ['https://evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['/č', '/'],
    ['/api/auth/logout', '/'],
    ['', '/'],
    [undefined, '/'],
    ['/warehouse/stock?x=1', '/warehouse/stock?x=1'],
  ])('%s → %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
