import { describe, expect, it } from 'vitest';
import {
  assertQrBaseUrlAllowed,
  PRODUCTION_QR_BASE_URL,
  QrUrlPolicyError,
  qrBaseUrlViolation,
} from './qr-policy.js';

describe('QR URL policy (DEV / production separation)', () => {
  it('lets production encode exactly the production QR base URL', () => {
    expect(qrBaseUrlViolation('production', PRODUCTION_QR_BASE_URL)).toBeNull();
  });

  it.each([
    'https://dev.ayvo.co/q',
    'http://localhost:3000/q',
    'http://qr.ayvo.co',
    'https://qr.ayvo.co/q',
    'https://QR.ayvo.co',
  ])('refuses production labels with base URL %s', (base) => {
    expect(() => assertQrBaseUrlAllowed('production', base)).toThrow(QrUrlPolicyError);
  });

  it.each(['development', 'test'] as const)(
    'never lets a %s process encode the production QR host',
    (env) => {
      for (const base of [
        PRODUCTION_QR_BASE_URL,
        'http://qr.ayvo.co',
        'https://QR.AYVO.CO/x',
        'https://qr.ayvo.co.',
        'https://qr.ayvo.co:8443/q',
        'https://user@qr.ayvo.co/q',
        'https://eu.qr.ayvo.co',
      ]) {
        expect(() => assertQrBaseUrlAllowed(env, base)).toThrow(/never encode a production QR URL/);
      }
      expect(qrBaseUrlViolation(env, 'https://dev.ayvo.co/q')).toBeNull();
    },
  );

  it('does not treat look-alike hosts as production', () => {
    for (const base of [
      'https://qr.ayvo.com',
      'https://notqr.ayvo.co',
      'https://qr.ayvo.co.example',
    ]) {
      expect(qrBaseUrlViolation('development', base)).toBeNull();
    }
  });
});
