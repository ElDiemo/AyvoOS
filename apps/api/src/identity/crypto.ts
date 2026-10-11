import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, base64url — session tokens, OAuth state, browser bindings, PKCE verifiers. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256 — only hashes of tokens are stored, never the tokens themselves. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** PKCE S256 code challenge of a verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
