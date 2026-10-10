import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conflicting Tailwind classes, last wins', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });

  it('drops falsy values', () => {
    const isActive = false as boolean;
    expect(cn('a', isActive && 'b', undefined, null, 'c')).toBe('a c');
  });
});
