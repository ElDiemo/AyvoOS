import { createHash, randomBytes } from 'node:crypto';

/** Print agent tokens (ADR 0028): `ayvo_pa_` + 256 random bits; only the SHA-256 is stored. */
export const AGENT_TOKEN_PREFIX = 'ayvo_pa_';
export const AGENT_HEADER = 'x-ayvo-print-agent';

export function newAgentToken(): { token: string; hash: string; hint: string } {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: agentTokenHash(token), hint: token.slice(-4) };
}

export const agentTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The shape of a token (checked before any database lookup). */
export const isAgentToken = (value: unknown): value is string =>
  typeof value === 'string' && /^ayvo_pa_[A-Za-z0-9_-]{43}$/.test(value);
