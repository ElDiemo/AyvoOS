import { describe, expect, it } from 'vitest';
import { canonicalJson, payloadHash } from './operation-requests.service.js';

describe('idempotency payload hash', () => {
  it('is independent of key order and ignores undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(payloadHash('LABEL_APPLICATION', { lotId: 'l', url: 'u' })).toBe(
      payloadHash('LABEL_APPLICATION', { url: 'u', lotId: 'l' }),
    );
  });

  it('differs for another operation kind or payload', () => {
    const h = payloadHash('LABEL_APPLICATION', { lotId: 'l', url: 'u' });
    expect(payloadHash('GOODS_RECEIPT', { lotId: 'l', url: 'u' })).not.toBe(h);
    expect(payloadHash('LABEL_APPLICATION', { lotId: 'm', url: 'u' })).not.toBe(h);
  });
});
