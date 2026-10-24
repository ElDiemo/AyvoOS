import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Secret, TOTP } from 'otpauth';

/** All work runs locally; neither library contacts an authentication service. */
const PASSWORD_OPTIONS = {
  // @node-rs/argon2's Algorithm is an ambient const enum (not usable with isolatedModules).
  algorithm: 2, // Argon2id, as defined by the library.
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 1024;
const TOTP_PERIOD_SECONDS = 30;
const MAX_SECRET_BYTES = 65_536;

export class PasswordWorkLimitError extends Error {
  constructor() {
    super('Password verification is busy; retry shortly');
  }
}

/**
 * Bound memory BEFORE starting Argon2, not just HTTP traffic. No unbounded password queue.
 * Unknown users take the same Argon2 verification path, using a random dummy password hash.
 */
export class NativePasswords {
  private active = 0;
  private readonly dummy: Promise<string>;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new Error('Invalid password concurrency');
    }
    this.dummy = hash(randomBytes(32), PASSWORD_OPTIONS);
    // A failed native module must not create an unhandled rejection before module startup.
    void this.dummy.catch(() => undefined);
  }

  async ready(): Promise<void> {
    await this.dummy;
  }

  async hash(password: string): Promise<string> {
    if (!validNewPassword(password)) throw new Error('Invalid new password');
    return this.work(() => hash(password, PASSWORD_OPTIONS));
  }

  async verify(password: string, encodedHash: string | null): Promise<boolean> {
    // Login is bounded too, but does not trim, normalize or impose the current enrollment policy.
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
    const dummy = await this.dummy;
    const usable = encodedHash !== null && validPasswordHash(encodedHash);
    const matched = await this.work(() => verify(usable ? encodedHash : dummy, password));
    return usable && matched;
  }

  private async work<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) throw new PasswordWorkLimitError();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}

export function validNewPassword(password: string): boolean {
  return (
    typeof password === 'string' &&
    [...password].length >= PASSWORD_MIN_LENGTH &&
    Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES
  );
}

/** Only hashes produced by our bounded policy; corrupted parameters cannot allocate arbitrary RAM. */
export function validPasswordHash(value: string): boolean {
  return /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(value);
}

export type NativeSecretPurpose = 'TOTP' | 'ENROLLMENT' | 'MAIL';

/** Versioned authenticated encryption; ciphertext cannot be moved to another user or purpose. */
export class NativeSecretBox {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('A separate 32-byte auth key is required');
    this.key = Buffer.from(keyHex, 'hex');
  }

  seal(userId: string, purpose: NativeSecretPurpose, plaintext: string): string {
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_SECRET_BYTES) {
      throw new Error('Authentication secret is too large');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(userId, purpose));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      body.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(userId: string, purpose: NativeSecretPurpose, encrypted: string): string {
    const parts = encrypted.split('.');
    if (
      parts.length !== 4 ||
      parts[0] !== 'v1' ||
      parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)) ||
      encrypted.length > MAX_SECRET_BYTES * 2
    )
      throw new Error('Invalid authentication ciphertext');
    const iv = Buffer.from(parts[1]!, 'base64url');
    const body = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid authentication ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(this.aad(userId, purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  private aad(userId: string, purpose: NativeSecretPurpose): Buffer {
    if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('Invalid authentication user');
    return Buffer.from(`ayvo:native-auth:v1:${userId}:${purpose}`, 'utf8');
  }
}

export function newTotpSecret(): string {
  return new Secret({ size: 32 }).base32;
}

function totp(secret: string, email: string): TOTP {
  // Reject corrupt/oversized secrets before passing them to a decoder.
  if (!/^[A-Z2-7]{32,64}$/.test(secret)) throw new Error('Invalid TOTP secret');
  return new TOTP({
    issuer: 'AYVO OS',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

export function totpEnrollmentUri(secret: string, email: string): string {
  return totp(secret, email).toString();
}

/**
 * Returns the matched time step, NOT an authorization/session. The caller must atomically
 * persist it with `last_totp_step < step` in the transaction that completes authentication.
 */
export function verifiedTotpStep(
  secret: string,
  code: string,
  nowMs: number,
  lastAcceptedStep: bigint | null,
): bigint | null {
  if (!/^\d{6}$/.test(code) || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const delta = totp(secret, '').validate({ token: code, timestamp: nowMs, window: 1 });
  if (delta === null) return null;
  const step = BigInt(Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000)) + delta);
  if (step < 0n || (lastAcceptedStep !== null && step <= lastAcceptedStep)) return null;
  return step;
}

/** One-time recovery codes have 128 random bits each, so a purpose-bound SHA-256 is appropriate. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () =>
    randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
  );
}

export function recoveryCodeHash(userId: string, code: string): string | null {
  if (!/^(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{8}){3})$/.test(code)) return null;
  return createHash('sha256')
    .update(`ayvo:recovery:v1:${userId}:${code.replaceAll('-', '').toUpperCase()}`)
    .digest('hex');
}

export type NativeActionPurpose = 'ENROLL' | 'RESET_PASSWORD';

export function nativeTokenHash(
  purpose: NativeActionPurpose | 'CHALLENGE',
  token: string,
): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash('sha256').update(`ayvo:native-token:v1:${purpose}:${token}`).digest('hex');
}
