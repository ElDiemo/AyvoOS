import { randomBytes } from 'node:crypto';

/**
 * Public QR identity of a bottle (ADR 0005, ADR 0014): 128 bits from the OS CSPRNG, encoded as
 * base64url without padding → 22 URL-safe characters. Independent of the internal id and the
 * sequential bottle code, so knowing one bottle's QR never helps to guess another's.
 */
export const PUBLIC_TOKEN_BYTES = 16;

export function generatePublicToken(): string {
  return randomBytes(PUBLIC_TOKEN_BYTES).toString('base64url');
}
