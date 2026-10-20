import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Encryption of carrier credentials entered in the administration (ADR 0027): AES-256-GCM with a
 * key that exists only in the server environment (CARRIER_CREDENTIALS_KEY). The ciphertext is bound
 * to its connection code and client id (additional authenticated data), so it cannot be moved to
 * another connection. Nothing here ever logs or returns a secret.
 */

export interface EncryptedSecret {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  keyId: string;
}

const keyBytes = (base64Key: string) => Buffer.from(base64Key, 'base64');
const aad = (code: string, clientId: string) => Buffer.from(`ayvo-carrier:${code}:${clientId}`);
const bytes = (b: Buffer) => new Uint8Array(b);

/** Identifies the key (never the key itself): a stored secret is read only with its own key. */
export const keyId = (base64Key: string) =>
  createHash('sha256')
    .update('ayvo-carrier-key:')
    .update(keyBytes(base64Key))
    .digest('hex')
    .slice(0, 16);

/** The carrier account a client id stands for — a fingerprint, never the id itself. */
export const accountOf = (carrier: string, clientId: string) =>
  createHash('sha256')
    .update(`ayvo-carrier-account:${carrier}:${clientId}`)
    .digest('hex')
    .slice(0, 16);

export function encryptSecret(
  base64Key: string,
  code: string,
  clientId: string,
  secret: string,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(base64Key), iv);
  cipher.setAAD(aad(code, clientId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: bytes(ciphertext),
    iv: bytes(iv),
    tag: bytes(cipher.getAuthTag()),
    keyId: keyId(base64Key),
  };
}

/** The secret, or null when it cannot be read with this key (another key, or tampered). */
export function decryptSecret(
  base64Key: string,
  code: string,
  clientId: string,
  stored: EncryptedSecret,
): string | null {
  if (stored.keyId !== keyId(base64Key)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(base64Key), stored.iv);
    decipher.setAAD(aad(code, clientId));
    decipher.setAuthTag(stored.tag);
    return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A keyed digest for idempotency payloads: lets a repeat be compared without storing the secret. */
export const secretDigest = (base64Key: string, value: string) =>
  createHmac('sha256', keyBytes(base64Key)).update(value).digest('hex');
