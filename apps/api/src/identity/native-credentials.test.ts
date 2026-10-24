import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  NativePasswords,
  NativeSecretBox,
  PasswordWorkLimitError,
  nativeTokenHash,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodeHash,
  totpEnrollmentUri,
  validNewPassword,
  validPasswordHash,
  verifiedTotpStep,
} from './native-credentials.js';

const USER = '01990000-0000-7000-8000-000000000001';
const OTHER = '01990000-0000-7000-8000-000000000002';
const PASSWORD = 'Moje dlouhé heslo se dvěma mezerami  ';

describe('native password storage (no external authentication service)', () => {
  const passwords = new NativePasswords(2);
  let encoded: string;
  beforeAll(async () => {
    await passwords.ready();
    encoded = await passwords.hash(PASSWORD);
  });

  it('stores salted Argon2id, never a plaintext or deterministic hash', async () => {
    expect(validPasswordHash(encoded)).toBe(true);
    expect(encoded).not.toContain(PASSWORD);
    expect(await passwords.hash(PASSWORD)).not.toBe(encoded);
    expect(await passwords.verify(PASSWORD, encoded)).toBe(true);
  });

  it('does not trim passwords or accept wrong passwords, unknown accounts or damaged hashes', async () => {
    expect(await passwords.verify(PASSWORD.trim(), encoded)).toBe(false);
    expect(await passwords.verify('wrong', encoded)).toBe(false);
    expect(await passwords.verify(PASSWORD, null)).toBe(false);
    expect(await passwords.verify(PASSWORD, '$argon2id$bad')).toBe(false);
    expect(validPasswordHash(encoded.replace('m=65536', 'm=999999999'))).toBe(false);
  });

  it('accepts passphrases, bounds input, and refuses unlimited expensive concurrent work', async () => {
    expect(validNewPassword('12 znaků ano!')).toBe(true);
    expect(validNewPassword('krátké')).toBe(false);
    expect(validNewPassword('x'.repeat(1025))).toBe(false);
    expect(validNewPassword('🔑'.repeat(257))).toBe(false);
    const first = passwords.verify(PASSWORD, encoded);
    const second = passwords.verify(PASSWORD, encoded);
    const third = passwords.verify(PASSWORD, encoded);
    await expect(third).rejects.toBeInstanceOf(PasswordWorkLimitError);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await passwords.verify(PASSWORD, encoded)).toBe(true);
  });
});

describe('native MFA secrets', () => {
  const key = randomBytes(32).toString('hex');
  const box = new NativeSecretBox(key);

  it('uses randomized authenticated encryption bound to user and purpose', () => {
    const secret = newTotpSecret();
    const encrypted = box.seal(USER, 'TOTP', secret);
    expect(encrypted).not.toContain(secret);
    expect(box.open(USER, 'TOTP', encrypted)).toBe(secret);
    expect(box.seal(USER, 'TOTP', secret)).not.toBe(encrypted);
    expect(() => box.open(OTHER, 'TOTP', encrypted)).toThrow();
    expect(() => box.open(USER, 'ENROLLMENT', encrypted)).toThrow();
    expect(() =>
      new NativeSecretBox(randomBytes(32).toString('hex')).open(USER, 'TOTP', encrypted),
    ).toThrow();
    const changed = encrypted.split('.');
    changed[2] = `A${changed[2]!.slice(1)}`;
    // Explicitly force a different first byte, including the rare original A case.
    if (changed.join('.') === encrypted) changed[2] = `B${changed[2]!.slice(1)}`;
    expect(() => box.open(USER, 'TOTP', changed.join('.'))).toThrow();
  });

  it('rejects missing keys and malformed ciphertext instead of using a fallback', () => {
    for (const keyValue of ['', 'abc', '0'.repeat(63), 'x'.repeat(64)]) {
      expect(() => new NativeSecretBox(keyValue)).toThrow();
    }
    for (const value of ['', 'v2.a.b.c', 'v1.a.b', 'v1.***.a.b', 'v1.a.b.c.d']) {
      expect(() => box.open(USER, 'TOTP', value)).toThrow();
    }
  });

  it('produces a local standard authenticator URI with AYVO issuer', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{52}$/);
    const uri = new URL(totpEnrollmentUri(secret, 'clovek+test@ayvo.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('issuer')).toBe('AYVO OS');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('matches RFC 6238 SHA1 vectors with the standard six-digit truncation', () => {
    const secret = Secret.fromUTF8('12345678901234567890').base32;
    for (const [seconds, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ] as const) {
      expect(verifiedTotpStep(secret, code, seconds * 1000, null)).toBe(
        BigInt(Math.floor(seconds / 30)),
      );
    }
  });

  it('accepts only the small clock window and refuses reuse of an accepted time step', () => {
    const secret = newTotpSecret();
    const otp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const now = 1_800_000_000_000;
    const code = otp.generate({ timestamp: now });
    const step = verifiedTotpStep(secret, code, now, null)!;
    expect(step).not.toBeNull();
    expect(verifiedTotpStep(secret, code, now, step)).toBeNull();
    expect(verifiedTotpStep(secret, code, now + 30_000, null)).toBe(step);
    expect(verifiedTotpStep(secret, code, now + 90_000, null)).toBeNull();
    for (const malformed of ['', '12345', '1234567', '123 456', 'abcdef']) {
      expect(verifiedTotpStep(secret, malformed, now, null)).toBeNull();
    }
  });
});

describe('high-entropy one-use material', () => {
  it('creates ten independent recovery codes; hashes are account-bound', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/);
      expect(recoveryCodeHash(USER, code)).toMatch(/^[a-f0-9]{64}$/);
      expect(recoveryCodeHash(USER, code.toLowerCase().replaceAll('-', ''))).toBe(
        recoveryCodeHash(USER, code),
      );
      expect(recoveryCodeHash(OTHER, code)).not.toBe(recoveryCodeHash(USER, code));
    }
    expect(recoveryCodeHash(USER, 'not a code')).toBeNull();
  });

  it('separates activation, reset and preauthentication tokens by purpose', () => {
    const token = randomBytes(32).toString('base64url');
    const hashes = ['ENROLL', 'RESET_PASSWORD', 'CHALLENGE'].map((purpose) =>
      nativeTokenHash(purpose as 'ENROLL' | 'RESET_PASSWORD' | 'CHALLENGE', token),
    );
    expect(new Set(hashes).size).toBe(3);
    expect(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash!))).toBe(true);
    expect(nativeTokenHash('ENROLL', '')).toBeNull();
    expect(nativeTokenHash('ENROLL', 'x'.repeat(1000))).toBeNull();
  });
});
