import { describe, expect, it } from 'vitest';
import { publicTokenSchema } from '@ayvo/types';
import { generatePublicToken } from './public-token.js';

describe('generatePublicToken', () => {
  it('produces 22 URL-safe characters (128 random bits)', () => {
    const token = generatePublicToken();
    expect(publicTokenSchema.safeParse(token).success).toBe(true);
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
  });

  it('does not repeat across many draws', () => {
    const tokens = new Set(Array.from({ length: 20_000 }, generatePublicToken));
    expect(tokens.size).toBe(20_000);
  });
});
