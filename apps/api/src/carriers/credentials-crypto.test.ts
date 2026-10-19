import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountOf, decryptSecret, encryptSecret, keyId } from './credentials-crypto.js';

const key = randomBytes(32).toString('base64');

describe('carrier credential encryption', () => {
  it('round-trips only with the same key, connection and client id; never in clear text', () => {
    const e = encryptSecret(key, 'PPL_TEST', 'client-1', 'synthetic-secret-value');
    expect(Buffer.from(e.ciphertext).toString('utf8')).not.toContain('synthetic-secret-value');
    expect(e.keyId).toBe(keyId(key));
    expect(decryptSecret(key, 'PPL_TEST', 'client-1', e)).toBe('synthetic-secret-value');
    expect(decryptSecret(key, 'PPL_OTHER', 'client-1', e)).toBeNull();
    expect(decryptSecret(key, 'PPL_TEST', 'client-2', e)).toBeNull();
    const other = randomBytes(32).toString('base64');
    expect(decryptSecret(other, 'PPL_TEST', 'client-1', e)).toBeNull();
    const tampered = { ...e, ciphertext: new Uint8Array(e.ciphertext.map((b) => b ^ 1)) };
    expect(decryptSecret(key, 'PPL_TEST', 'client-1', tampered)).toBeNull();
  });

  it('a fresh IV per encryption; the account is a fingerprint of the client id', () => {
    const a = encryptSecret(key, 'PPL_TEST', 'c', 's');
    const b = encryptSecret(key, 'PPL_TEST', 'c', 's');
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(accountOf('PPL', 'c')).toMatch(/^[0-9a-f]{16}$/);
    expect(accountOf('PPL', 'c')).not.toBe(accountOf('PPL', 'd'));
  });
});
