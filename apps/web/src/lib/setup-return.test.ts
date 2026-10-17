import { describe, expect, it } from 'vitest';
import { setupReturn } from './setup-return';

describe('setupReturn', () => {
  it('accepts only the setup page, optionally with a product', () => {
    expect(setupReturn('/production/setup')).toBe('/production/setup');
    expect(setupReturn('/production/setup?product=P-AB12')).toBe(
      '/production/setup?product=P-AB12',
    );
    for (const bad of [
      'https://evil.test/production/setup',
      '//evil.test',
      '/production/setup?product=x&next=/admin',
      '/admin/users',
      '/production/setup?product=<script>',
      42,
      null,
    ]) {
      expect(setupReturn(bad)).toBeNull();
    }
  });
});
