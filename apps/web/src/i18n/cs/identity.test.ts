import { PERMISSION_CODES } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { identityCs } from './identity';

describe('Czech permission labels', () => {
  it('gives every known permission a non-empty name that is not its technical slug', () => {
    for (const code of PERMISSION_CODES) {
      const name = identityCs.permissions[code];
      expect(name, code).toBeTypeOf('string');
      expect(name!.trim(), code).not.toBe('');
      expect(name, code).not.toBe(code);
      expect(name, code).not.toContain(':');
    }
  });

  it('names purchase price recording in Czech', () => {
    expect(identityCs.permissions['procurement:cost_write']).toBe('Upravovat nákupní ceny');
  });
});
