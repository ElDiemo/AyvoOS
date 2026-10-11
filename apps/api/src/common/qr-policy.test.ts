import { describe, expect, it } from 'vitest';
import {
  assertQrBaseUrlAllowed,
  classifyScannedQr,
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

describe('classifyScannedQr (physical label scan, doc 018)', () => {
  const base = 'https://dev.ayvo.co/q';
  const token = 'abcDEF0123456789_-xyzA';

  it('accepts exactly <base>/<token>, removing only scanner whitespace and CR/LF', () => {
    expect(classifyScannedQr(`${base}/${token}`, base)).toEqual({
      kind: 'TOKEN',
      url: `${base}/${token}`,
      token,
    });
    expect(classifyScannedQr(` \t${base}/${token}\r\n`, base)).toMatchObject({
      kind: 'TOKEN',
      token,
    });
  });

  it('never repairs input: raw tokens, codes, case or path changes are not AYVO labels', () => {
    for (const value of [
      token,
      'AYV-B-000001',
      `${base.toUpperCase()}/${token}`,
      `${base}/${token}/`,
      `${base}/${token}x`,
      `${base}/${token.toLowerCase()}x`.slice(0, -1) + '!',
      `${base}?t=${token}`,
      '',
      'not a url',
    ]) {
      expect(classifyScannedQr(value, base).kind, value).toBe('NOT_AYVO_QR');
    }
  });

  it('labels of another AYVO environment are WRONG_ENVIRONMENT', () => {
    expect(classifyScannedQr(`https://qr.ayvo.co/${token}`, base).kind).toBe('WRONG_ENVIRONMENT');
    expect(classifyScannedQr(`https://dev.ayvo.co/q/${token}`, 'https://qr.ayvo.co').kind).toBe(
      'WRONG_ENVIRONMENT',
    );
    expect(classifyScannedQr(`https://example.com/q/${token}`, base).kind).toBe('NOT_AYVO_QR');
  });
});
